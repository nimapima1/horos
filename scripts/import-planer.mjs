// Importerar planer (detaljplaner, stadsplaner, områdesbestämmelser m.fl.) ur Lantmäteriets
// "Markreglerande bestämmelse Nedladdning, vektor" (GeoPackage, SWEREF 99 TM). Produkten
// levereras per kommun; kör skriptet en gång per fil. Samma plan i två filer ersätts.
//
//   node scripts/import-planer.mjs data/raw/markreglerande-0180.gpkg [flaggor]
//     --list               visa lager, kolumner och plantyper i filen och avsluta
//     --dry                läs filen och visa vad som skulle importeras, men skriv inget
//     --layer <tabell>     lagret med planytor (gissas annars, t.ex. plan_yta)
//     --typ <kolumn>       kolumnen med plantyp (DP, SPL, ...)     } gissas
//     --planid <kolumn>    kolumnen med planens beteckning/akt      } annars
//     --namn <kolumn>      kolumnen med planens namn                }
//     --datum <kolumn>     kolumnen med laga kraft-datum            }
//     --kommun <namn>      kommunnamn att spara (annars ur filens kommunkolumn)
import { DatabaseSync } from 'node:sqlite';
import { openDb, geomBbox, withTransaction } from '../lib/db.mjs';
import { parseGpkgGeometry, sweref99tmToWgs84, mapCoords, round6 } from '../lib/geo.mjs';
import { parseArgs } from '../lib/csv.mjs';

// Plantyperna i produkten; övriga bestämmelser (naturreservat, byggnadsminnen m.m.) hoppas över.
const PLANTYPER = new Set(['DP', 'ÄDP', 'SPL', 'BPL', 'OB', 'ÄOB', 'FP', 'TI', 'APL', 'GPL']);

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

const layer = layers.find((l) => l.table_name === args.layer)
  ?? layers.find((l) => /plan.*yta|yta.*plan/i.test(l.table_name) && /POLYGON/i.test(l.gtype))
  ?? layers.find((l) => /plan/i.test(l.table_name) && /POLYGON/i.test(l.gtype))
  ?? layers.find((l) => /POLYGON/i.test(l.gtype));
const cols = layer ? columnsOf(layer.table_name) : [];
const find = (...res) => res.map((re) => cols.find((c) => re.test(c))).find(Boolean);
const col = {
  typ: args.typ ?? find(/^objekttyp$/i, /plantyp/i, /typ/i),
  planid: args.planid ?? find(/akt/i, /planbeteckning/i, /planid/i, /beteckning/i),
  namn: args.namn ?? find(/plannamn/i, /namn/i),
  datum: args.datum ?? find(/laga.?kraft/i, /beslut/i, /datum/i),
  id: find(/objektidentitet/i, /uuid/i),
  kommun: find(/kommunnamn/i, /kommun/i),
};

if (args.list) {
  for (const l of layers) {
    const { n } = gpkg.prepare(`SELECT count(*) AS n FROM "${l.table_name}"`).get();
    console.log(`\n${l.table_name}  (${l.gtype}, EPSG:${l.srs_id}, ${n} rader)`);
    const sample = gpkg.prepare(`SELECT * FROM "${l.table_name}" LIMIT 1`).get() ?? {};
    for (const c of columnsOf(l.table_name)) if (c !== l.geom) console.log(`  ${c.padEnd(32)} ${String(sample[c] ?? '').slice(0, 60)}`);
  }
  if (layer && col.typ) {
    console.log(`\nPlantyper i ${layer.table_name}.${col.typ}:`);
    for (const r of gpkg.prepare(`SELECT "${col.typ}" AS t, count(*) AS n FROM "${layer.table_name}" GROUP BY 1 ORDER BY 2 DESC LIMIT 40`).all()) {
      console.log(`  ${String(r.t).padEnd(12)} ${String(r.n).padStart(7)}${PLANTYPER.has(String(r.t).toUpperCase()) ? '' : '  (hoppas över)'}`);
    }
  }
  process.exit(0);
}

if (!layer) throw new Error('Hittade inget polygonlager. Kör med --list och ange --layer.');
if (!col.typ) throw new Error('Hittade ingen kolumn med plantyp. Kör med --list och ange --typ.');
if (layer.srs_id !== 3006) console.warn(`Varning: lagret har EPSG:${layer.srs_id}, skriptet förväntar SWEREF 99 TM (3006).`);
console.log(`Lager: ${layer.table_name} · ${Object.entries(col).map(([k, v]) => `${k}: ${v ?? '–'}`).join(' · ')}`);

const rows = [];
const skipped = new Map();
for (const r of gpkg.prepare(`SELECT rowid AS _fid, * FROM "${layer.table_name}"`).iterate()) {
  const typ = String(r[col.typ] ?? '').trim().toUpperCase();
  if (!PLANTYPER.has(typ)) { skipped.set(typ, (skipped.get(typ) ?? 0) + 1); continue; }
  const g = parseGpkgGeometry(r[layer.geom]);
  if (!g || !/Polygon$/.test(g.type)) { skipped.set('(utan yta)', (skipped.get('(utan yta)') ?? 0) + 1); continue; }
  const wgs = mapCoords(g, ([x, y]) => round6(sweref99tmToWgs84(x, y)));
  const planid = col.planid && r[col.planid] != null ? String(r[col.planid]).trim() : null;
  rows.push({
    id: col.id && r[col.id] ? String(r[col.id]) : `${planid ?? typ}#${r._fid}`,
    typ, planid,
    namn: col.namn && r[col.namn] ? String(r[col.namn]).trim() : null,
    datum: col.datum && r[col.datum] ? String(r[col.datum]).slice(0, 10) : null,
    kommun: args.kommun ?? (col.kommun && r[col.kommun] ? String(r[col.kommun]).trim() : null),
    geojson: JSON.stringify(wgs), ...geomBbox(wgs),
  });
}
const perTyp = rows.reduce((m, r) => m.set(r.typ, (m.get(r.typ) ?? 0) + 1), new Map());
console.log(`${rows.length} planer: ${[...perTyp].map(([t, n]) => `${t} ${n}`).join(', ') || 'inga'}`);
if (skipped.size) console.log(`Hoppade över: ${[...skipped].map(([t, n]) => `${t || '(tom)'} ${n}`).join(', ')}`);
if (args.dry) {
  console.log('Exempel:', rows.slice(0, 3).map(({ geojson, ...r }) => r));
  process.exit(0);
}

const db = openDb();
const ins = db.prepare(`INSERT OR REPLACE INTO plan (id, typ, planid, namn, datum, kommun, geojson, minx, miny, maxx, maxy, demo)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`);
withTransaction(db, () => {
  for (const r of rows) ins.run(r.id, r.typ, r.planid, r.namn, r.datum, r.kommun, r.geojson, r.minx, r.miny, r.maxx, r.maxy);
});
console.log(`Klart: ${rows.length} planer importerade.`);
