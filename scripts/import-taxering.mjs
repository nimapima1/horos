// Importerar taxeringsuppgifter från Skatteverkets utlämnade fil (CSV eller Excel sparad som CSV).
// Kolumnnamnen är okända tills svaret kommer, så de gissas via synonymer.
// Kör först med --dry för att se vilka kolumner som hittades.
//
//   node scripts/import-taxering.mjs data/raw/taxering.csv [--dry] [--enhet kr|tkr] [--map fält=kolumn ...]
//
// Fält: beteckning, taxeringsenhet, typ, ar, varde, markvarde, byggvarde, orgnr, andel
// Rader där ägaren inte är en juridisk person (personnummer) hoppas över.
import { openDb, normOrgnr, normBeteckning, withTransaction } from '../lib/db.mjs';
import { readTable, mapColumns, parseArgs, num } from '../lib/csv.mjs';

const args = parseArgs(process.argv.slice(2));
const file = args._[0];
if (!file) { console.error('Ange CSV-fil. Se kommentaren överst i skriptet.'); process.exit(1); }

const FIELDS = {
  beteckning: ['fastighetsbeteckning', 'beteckning', 'fastighet', 'registerbeteckning'],
  taxeringsenhet: ['taxeringsenhetsnummer', 'taxeringsenhet', 'tenr', 'taxenhet'],
  typ: ['typkod', 'taxeringsenhetstyp', 'typ'],
  ar: ['taxeringsar', 'ar', 'taxar'],
  varde: ['taxeringsvarde', 'totaltaxeringsvarde', 'tax_varde', 'varde'],
  markvarde: ['markvarde', 'tomtvarde', 'markvärde'],
  byggvarde: ['byggnadsvarde', 'byggvarde', 'byggnadsvärde'],
  orgnr: ['organisationsnummer', 'orgnr', 'agareid', 'agaresidentitet', 'personorganisationsnummer', 'idnummer'],
  andel: ['agarandel', 'andel'],
};

const { header, rows } = readTable(file);
const col = mapColumns(header, FIELDS, args.map);
console.log(`${rows.length} rader. Kolumner i filen: ${header.join(' | ')}`);
for (const f of Object.keys(FIELDS)) console.log(`  ${f.padEnd(15)} -> ${col[f] != null ? header[col[f]] : '(saknas)'}`);
if (col.beteckning == null || col.varde == null) {
  console.error('\nBeteckning och taxeringsvärde måste hittas. Ange dem med --map, t.ex. --map beteckning="Fastighet"');
  process.exit(1);
}

// Skatteverket anger normalt värden i tkr. Gissa om inget anges: medianvärde > 100 000 => kr.
const values = rows.map((r) => num(r[col.varde])).filter((v) => v != null).sort((x, y) => x - y);
const enhet = args.enhet ?? (values[Math.floor(values.length / 2)] > 100000 ? 'kr' : 'tkr');
const toTkr = (v) => (v == null ? null : Math.round(enhet === 'kr' ? v / 1000 : v));
console.log(`Värden tolkas som ${enhet}.`);

const get = (r, f) => (col[f] != null ? String(r[col[f]] ?? '').trim() || null : null);
let personer = 0;
const recs = [];
const privata = new Set();
for (const r of rows) {
  const orgnrRaw = get(r, 'orgnr');
  const orgnr = orgnrRaw ? normOrgnr(orgnrRaw) : null;
  if (orgnrRaw && !orgnr) {                              // personnummer: spara aldrig
    personer++;
    privata.add(normBeteckning(get(r, 'beteckning')));   // bara beteckningen, för uteslutning
    continue;
  }
  recs.push([normBeteckning(get(r, 'beteckning')), get(r, 'taxeringsenhet'), get(r, 'typ'), num(get(r, 'ar')),
    toTkr(num(get(r, 'varde'))), toTkr(num(get(r, 'markvarde'))), toTkr(num(get(r, 'byggvarde'))), orgnr, get(r, 'andel')]);
}
console.log(`${recs.length} rader att importera, ${personer} hoppade över (fysiska personer).`);
if (args.dry) { console.log('Exempel:', recs.slice(0, 3)); process.exit(0); }

const db = openDb();
const ins = db.prepare(`INSERT INTO taxering (beteckning, taxeringsenhet, typ, ar, varde_tkr, markvarde_tkr, byggvarde_tkr, agare_orgnr, andel, demo)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`);
withTransaction(db, () => {
  if (!args.append) db.exec('DELETE FROM taxering WHERE demo = 0');
  for (const r of recs) ins.run(...r);
  const insP = db.prepare('INSERT OR IGNORE INTO har_privat_agare (beteckning) VALUES (?)');
  for (const b of privata) if (b) insP.run(b);
});
const { utan } = db.prepare(`SELECT count(DISTINCT t.beteckning) AS utan FROM taxering t
  LEFT JOIN fastighet f ON f.beteckning = t.beteckning WHERE t.demo = 0 AND f.beteckning IS NULL`).get();
console.log(`Klart. ${utan} beteckningar saknar karta (importera Fastighetsindelning, eller kontrollera att beteckningarna skrivs likadant).`);
