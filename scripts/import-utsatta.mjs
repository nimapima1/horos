// Importerar Polisens utsatta områden (lägesbilden, områdesgränser som GeoJSON i SWEREF 99 TM).
// Filen gäller hela landet och ersätter tabellen. Ladda ner från
// https://polisen.se/om-polisen/polisens-arbete/utsatta-omraden/ ("geo.json", zip) och packa upp.
//
//   node scripts/import-utsatta.mjs data/raw/uso/uso_2025.geojson [--dry]
import { readFileSync } from 'node:fs';
import { openDb, withTransaction } from '../lib/db.mjs';
import { sweref99tmToWgs84, mapCoords, round6 } from '../lib/geo.mjs';
import { parseArgs } from '../lib/csv.mjs';

const args = parseArgs(process.argv.slice(2));
const file = args._[0];
if (!file) { console.error('Ange sökväg till GeoJSON-filen. Se kommentaren överst i skriptet.'); process.exit(1); }

const fc = JSON.parse(readFileSync(file, 'utf8'));
const crs = fc.crs?.properties?.name ?? '';
if (!/3006/.test(crs)) throw new Error(`Filen har koordinatsystem "${crs}", skriptet förväntar SWEREF 99 TM (EPSG:3006).`);

const rows = fc.features.filter((f) => /Polygon$/.test(f.geometry?.type)).map(({ properties: p, geometry }) => ({
  id: p.OBJECTID, namn: p.NAMN.trim(), kategori: p.KATEGORI.trim(), ort: p.ORT?.trim() || null,
  polisomrade: p.POLISOMRADE?.trim() || null, datum: p.AKTUALITET_START?.trim() || null,
  geojson: JSON.stringify(mapCoords(geometry, ([x, y]) => round6(sweref99tmToWgs84(x, y)))),
}));
const perKategori = rows.reduce((m, r) => m.set(r.kategori, (m.get(r.kategori) ?? 0) + 1), new Map());
console.log(`${rows.length} områden: ${[...perKategori].map(([k, n]) => `${k} ${n}`).join(', ')}`);
if (args.dry) { console.log('Exempel:', rows.slice(0, 3).map(({ geojson, ...r }) => r)); process.exit(0); }

const db = openDb();
const ins = db.prepare('INSERT INTO utsatt_omrade (id, namn, kategori, ort, polisomrade, datum, geojson) VALUES (?, ?, ?, ?, ?, ?, ?)');
withTransaction(db, () => {
  db.exec('DELETE FROM utsatt_omrade');
  for (const r of rows) ins.run(r.id, r.namn, r.kategori, r.ort, r.polisomrade, r.datum, r.geojson);
});
console.log(`Klart: ${rows.length} utsatta områden importerade.`);
