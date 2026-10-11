// Importerar potentiellt förorenade områden ur länsstyrelsernas EBH-stöd (öppna data, CC BY 4.0).
// Filen gäller hela landet och ersätter tabellen. Ladda ner och packa upp:
//   https://ext-dokument.lansstyrelsen.se/Gemensamt/Geodata/Datadistribution/SWEREF99TM/EBH_Potentiellt_fororenade_omraden.zip
//
//   node scripts/import-fororenade.mjs data/raw/ebh/EBH_Potentiellt_fororenade_omraden.dbf [--dry]
//
// Koordinaterna (N, E i SWEREF 99 TM) står i attributtabellen, så bara .dbf-filen läses.
import { readFileSync } from 'node:fs';
import { openDb, withTransaction } from '../lib/db.mjs';
import { sweref99tmToWgs84, round6 } from '../lib/geo.mjs';
import { parseArgs, readDbf } from '../lib/csv.mjs';

const args = parseArgs(process.argv.slice(2));
const file = args._[0];
if (!file) { console.error('Ange sökväg till .dbf-filen. Se kommentaren överst i skriptet.'); process.exit(1); }

const rows = readDbf(readFileSync(file)).map((r) => {
  const [lon, lat] = round6(sweref99tmToWgs84(Number(r.E), Number(r.N)));
  return { id: Number(r.EBH_ID), kommun: r.KOMMUN || null, bransch: r.P_BRANSCH || null, bransch2: r.S_BRANSCH || null,
    status: r.STATUS || null, riskklass: /^[1-4]$/.test(r.RISKKLASS) ? Number(r.RISKKLASS) : null, lon, lat };
}).filter((r) => r.id && Number.isFinite(r.lon) && Number.isFinite(r.lat));

const per = (k) => [...rows.reduce((m, r) => m.set(r[k], (m.get(r[k]) ?? 0) + 1), new Map())].map(([v, n]) => `${v ?? '–'} ${n}`).join(', ');
console.log(`${rows.length} objekt\n  riskklass: ${per('riskklass')}\n  status: ${per('status')}`);
if (args.dry) { console.log('Exempel:', rows.slice(0, 3)); process.exit(0); }

const db = openDb();
const ins = db.prepare(`INSERT OR REPLACE INTO fororenat (ebh_id, kommun, bransch, bransch2, status, riskklass, lon, lat)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
withTransaction(db, () => {
  db.exec('DELETE FROM fororenat');
  for (const r of rows) ins.run(r.id, r.kommun, r.bransch, r.bransch2, r.status, r.riskklass, r.lon, r.lat);
});
console.log(`Klart: ${rows.length} förorenade områden importerade.`);
