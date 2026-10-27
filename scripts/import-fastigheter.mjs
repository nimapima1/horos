// Importerar Lantmäteriets Fastighetsindelning (GeoPackage, SWEREF 99 TM). Produkten levereras
// per kommun; kör skriptet en gång per fil.
// Beställ "Fastighetsindelning Nedladdning, vektor" (avgiftsfri, kräver juridisk prövning) på
// https://geotorget.lantmateriet.se och lägg filen i data/raw/.
//
//   node scripts/import-fastigheter.mjs data/raw/fastighetsindelning.gpkg [flaggor]
//     --dry                  läs och kontrollera filen, skriv inget
//     --list                 visa lager och kolumner i filen och avsluta
//     --layer <tabell>       vilket lager som innehåller fastighetsytor (gissas annars)
//     --beteckning <kolumn>  kolumn med fastighetsbeteckning (gissas annars)
//     --kommun <värde>       behåll bara rader där kommunkolumnen matchar, t.ex. 0180 (standard: alla)
//     --kommun-kolumn <kol>  kolumn för kommunfiltret (gissas annars)
import { DatabaseSync } from 'node:sqlite';
import { openDb, geomBbox, fastighetsBet, withTransaction, rebuildFastighetFts } from '../lib/db.mjs';
import { parseGpkgGeometry, sweref99tmToWgs84, mapCoords, planarArea, round6 } from '../lib/geo.mjs';
import { parseArgs } from '../lib/csv.mjs';
import { kommunAv, kommunForst } from '../lib/kommuner.mjs';

const args = parseArgs(process.argv.slice(2));
const file = args._[0];
if (!file) {
  console.error('Ange sökväg till GeoPackage-filen. Se kommentaren överst i skriptet.');
  process.exit(1);
}

const gpkg = new DatabaseSync(file, { readOnly: true });
const layers = gpkg.prepare(`SELECT c.table_name, g.column_name AS geom, g.geometry_type_name AS gtype, c.srs_id
  FROM gpkg_contents c JOIN gpkg_geometry_columns g ON g.table_name = c.table_name
  WHERE c.data_type = 'features'`).all();
const columnsOf = (t) => gpkg.prepare(`PRAGMA table_info("${t}")`).all().map((c) => c.name);

if (args.list) {
  for (const l of layers) {
    const { n } = gpkg.prepare(`SELECT count(*) AS n FROM "${l.table_name}"`).get();
    console.log(`\n${l.table_name}  (${l.gtype}, EPSG:${l.srs_id}, ${n} rader)`);
    const sample = gpkg.prepare(`SELECT * FROM "${l.table_name}" LIMIT 1`).get() ?? {};
    for (const c of columnsOf(l.table_name)) if (c !== l.geom) console.log(`  ${c.padEnd(32)} ${String(sample[c] ?? '').slice(0, 60)}`);
  }
  process.exit(0);
}

const layer = layers.find((l) => l.table_name === args.layer)
  ?? layers.find((l) => /yta|omrade|fastighet/i.test(l.table_name) && /POLYGON/i.test(l.gtype))
  ?? layers.find((l) => /POLYGON/i.test(l.gtype));
if (!layer) throw new Error('Hittade inget polygonlager. Kör med --list och ange --layer.');
if (layer.srs_id !== 3006) console.warn(`Varning: lagret har EPSG:${layer.srs_id}, skriptet förväntar SWEREF 99 TM (3006).`);

const cols = columnsOf(layer.table_name);
const find = (re) => cols.find((c) => re.test(c));
const betCol = args.beteckning ?? find(/^fastighetsbeteckning$/i) ?? find(/beteckning/i);
const kommunCol = args['kommun-kolumn'] ?? find(/^kommunkod$/i) ?? find(/kommunnamn/i) ?? find(/kommun/i);
const kommunVal = args.kommun ? String(args.kommun).toUpperCase() : null;
const kommunMatch = (v) => {
  const s = String(v ?? '').toUpperCase().trim();
  return !kommunVal || (kommunAv(s) && kommunAv(s) === kommunAv(kommunVal));
};

// Beteckning byggs av delar om ingen färdig kolumn finns.
const parts = { kommun: find(/kommunnamn/i), trakt: find(/trakt/i), block: find(/block/i), enhet: find(/^enhet$|enhetsnummer|^enhet/i) };
const betOf = (r) => {
  if (betCol && r[betCol]) return fastighetsBet(r[betCol], r[parts.kommun] ?? r[kommunCol] ?? args.kommun);
  if (parts.trakt) {
    const be = [r[parts.block], r[parts.enhet]].filter((x) => x != null && x !== '').join(':');
    return fastighetsBet([r[parts.trakt], be].filter(Boolean).join(' '), r[parts.kommun] ?? r[kommunCol] ?? args.kommun, { utanKommun: true });
  }
  return null;
};

console.log(`Lager: ${layer.table_name} · beteckning: ${betCol ?? `${parts.trakt}+${parts.block}+${parts.enhet}`} · kommunfilter: ${kommunVal ? `${kommunCol}=${kommunVal}` : '(inget)'}`);

// Samla ytor per beteckning (en fastighet kan ha flera skiften).
const byBet = new Map();
let read = 0, skipped = 0;
for (const r of gpkg.prepare(`SELECT * FROM "${layer.table_name}"`).iterate()) {
  read++;
  if (kommunCol && !kommunMatch(r[kommunCol])) { skipped++; continue; }
  const bet = betOf(r);
  const g = parseGpkgGeometry(r[layer.geom]);
  if (!bet || !g) { skipped++; continue; }
  const polys = g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : [];
  if (!byBet.has(bet)) byBet.set(bet, { kommun: kommunForst(bet).kommun, polys: [] });
  byBet.get(bet).polys.push(...polys);
}
console.log(`${read} ytor lästa, ${skipped} utanför kommunen eller utan beteckning, ${byBet.size} fastigheter.`);

gpkg.close();
if (args.dry) { console.log('Torrkörning: inget sparat.'); process.exit(0); }

const db = openDb();
const ins = db.prepare(`INSERT OR REPLACE INTO fastighet (beteckning, kommun, areal_m2, geojson, minx, miny, maxx, maxy, kalla, demo)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'lantmateriet', 0)`);
withTransaction(db, () => {
  for (const [bet, { kommun, polys }] of byBet) {
    const src = polys.length === 1 ? { type: 'Polygon', coordinates: polys[0] } : { type: 'MultiPolygon', coordinates: polys };
    const area = planarArea(src);
    const wgs = mapCoords(src, ([x, y]) => round6(sweref99tmToWgs84(x, y)));
    const bb = geomBbox(wgs);
    ins.run(bet, kommun, Math.round(area), JSON.stringify(wgs), bb.minx, bb.miny, bb.maxx, bb.maxy);
  }
});
rebuildFastighetFts(db);
console.log(`Klart: ${byBet.size} fastigheter importerade. Ta bort exempeldata med: npm run demo -- --clear`);
