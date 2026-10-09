// Importerar taxeringsuppgifter från Skatteverkets utlämnade fil (CSV eller Excel sparad som CSV).
// Kolumnnamnen är okända tills svaret kommer, så de gissas via synonymer.
// Kör först med --dry för att se vilka kolumner som hittades.
//
//   node scripts/import-taxering.mjs data/raw/taxering.csv [--dry] [--enhet kr|tkr] [--map fält=kolumn ...]
//
// Fält: beteckning, taxeringsenhet, typ, ar, varde, markvarde, byggvarde, orgnr, andel
// Rader där ägaren inte är en juridisk person (personnummer) hoppas över.
import { openDb, normOrgnr, normBeteckning, withTransaction, markPrivata } from '../lib/db.mjs';
import { loadMapped, parseArgs, num } from '../lib/csv.mjs';

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

const { rows, get } = loadMapped(file, FIELDS, args.map, ['beteckning', 'varde']);

// Skatteverket anger normalt värden i tkr. Gissa om inget anges: medianvärde > 100 000 => kr.
const values = rows.map((r) => num(get(r, 'varde'))).filter((v) => v != null).sort((x, y) => x - y);
const enhet = args.enhet ?? (values[Math.floor(values.length / 2)] > 100000 ? 'kr' : 'tkr');
const toTkr = (v) => (v == null ? null : Math.round(enhet === 'kr' ? v / 1000 : v));
console.log(`Värden tolkas som ${enhet}.`);

let personer = 0;
const recs = [];
const privata = new Set();
for (const r of rows) {
  const orgnrRaw = get(r, 'orgnr');
  const orgnr = normOrgnr(orgnrRaw);
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
  markPrivata(db, privata);
});
const { utan } = db.prepare(`SELECT count(DISTINCT t.beteckning) AS utan FROM taxering t
  LEFT JOIN fastighet f ON f.beteckning = t.beteckning WHERE t.demo = 0 AND f.beteckning IS NULL`).get();
console.log(`Klart. ${utan} beteckningar saknar karta (importera Fastighetsindelning, eller kontrollera att beteckningarna skrivs likadant).`);
