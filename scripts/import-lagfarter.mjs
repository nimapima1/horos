// Importerar Lantmäteriets utlämnade uppgifter om lagfarter (CSV).
//
//   node scripts/import-lagfarter.mjs <fil.csv> --som transaktioner   överlåtelser med köpeskilling
//   node scripts/import-lagfarter.mjs <fil.csv> --som agare           nuvarande lagfarna ägare
//   flaggor: [--dry] [--append] [--map fält=kolumn ...]
//
// Fält: beteckning, orgnr, andel, datum, kopeskilling, art
// Rader med personnummer hoppas alltid över.
import { openDb, normOrgnr, normBeteckning, withTransaction } from '../lib/db.mjs';
import { readTable, mapColumns, parseArgs, num, isoDate } from '../lib/csv.mjs';

const args = parseArgs(process.argv.slice(2));
const file = args._[0];
const som = args.som ?? 'transaktioner';
if (!file || !['transaktioner', 'agare'].includes(som)) {
  console.error('Ange CSV-fil och --som transaktioner|agare. Se kommentaren överst i skriptet.');
  process.exit(1);
}

const FIELDS = {
  beteckning: ['fastighetsbeteckning', 'beteckning', 'fastighet', 'registerbeteckning'],
  orgnr: ['organisationsnummer', 'orgnr', 'forvarvareid', 'agareid', 'personorganisationsnummer', 'idnummer',
    'forvarvare', 'kopare', 'lagfarenagare', 'agare', 'lagfaren'],
  andel: ['andel', 'agarandel'],
  datum: ['inskrivningsdag', 'inskrivningsdatum', 'beviljad', 'datum', 'forvarvsdatum'],
  kopeskilling: ['kopeskilling', 'kopesumma', 'pris', 'kopeskillingkr'],
  art: ['overlatelseform', 'forvarvsart', 'fangesart', 'art', 'fang'],
};

const { header, rows } = readTable(file);
const col = mapColumns(header, FIELDS, args.map);
console.log(`${rows.length} rader. Kolumner i filen: ${header.join(' | ')}`);
for (const f of Object.keys(FIELDS)) console.log(`  ${f.padEnd(13)} -> ${col[f] != null ? header[col[f]] : '(saknas)'}`);
if (col.beteckning == null || col.orgnr == null) {
  console.error('\nBeteckning och organisationsnummer måste hittas. Ange dem med --map.');
  process.exit(1);
}

const get = (r, f) => (col[f] != null ? String(r[col[f]] ?? '').trim() || null : null);
let personer = 0;
const recs = [];
const privata = new Set();
for (const r of rows) {
  const orgnr = normOrgnr(get(r, 'orgnr'));
  if (!orgnr) {                                          // personnummer: spara aldrig
    personer++;
    if (som === 'agare') privata.add(normBeteckning(get(r, 'beteckning')));  // bara beteckningen
    continue;
  }
  recs.push({ bet: normBeteckning(get(r, 'beteckning')), orgnr, andel: get(r, 'andel'), datum: isoDate(get(r, 'datum')),
    pris: num(get(r, 'kopeskilling')), art: get(r, 'art') });
}
console.log(`${recs.length} rader att importera, ${personer} hoppade över (fysiska personer eller saknat org.nr).`);
if (args.dry) { console.log('Exempel:', recs.slice(0, 3)); process.exit(0); }

const db = openDb();
withTransaction(db, () => {
  if (som === 'agare') {
    if (!args.append) db.exec('DELETE FROM agande WHERE demo = 0');
    const ins = db.prepare('INSERT INTO agande (beteckning, orgnr, andel, inskrivningsdag, demo) VALUES (?, ?, ?, ?, 0)');
    for (const r of recs) ins.run(r.bet, r.orgnr, r.andel, r.datum);
    const insP = db.prepare('INSERT OR IGNORE INTO har_privat_agare (beteckning) VALUES (?)');
    for (const b of privata) if (b) insP.run(b);
  } else {
    if (!args.append) db.exec('DELETE FROM transaktion WHERE demo = 0');
    const ins = db.prepare(`INSERT INTO transaktion (beteckning, inskrivningsdag, kopeskilling_kr, forvarvare_orgnr, art, andel, demo)
      VALUES (?, ?, ?, ?, ?, ?, 0)`);
    for (const r of recs) ins.run(r.bet, r.datum, r.pris == null ? null : Math.round(r.pris), r.orgnr, r.art, r.andel);
  }
});
const { okanda } = db.prepare(`SELECT count(DISTINCT x.o) AS okanda FROM
  (SELECT orgnr AS o FROM agande WHERE demo = 0 UNION SELECT forvarvare_orgnr FROM transaktion WHERE demo = 0) x
  LEFT JOIN bolag b ON b.orgnr = x.o WHERE b.orgnr IS NULL`).get();
console.log(`Klart. ${okanda} organisationsnummer finns inte i bolagsregistret (kör npm run import:bolag med färska filer).`);
