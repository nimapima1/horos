// Importerar Lantmäteriets utlämnade uppgifter om lagfarter (CSV).
//
//   node scripts/import-lagfarter.mjs <fil.csv> --som transaktioner   överlåtelser med köpeskilling
//   node scripts/import-lagfarter.mjs <fil.csv> --som agare           nuvarande lagfarna ägare
//   flaggor: [--dry] [--append] [--map fält=kolumn ...]
//
// Fält: beteckning, orgnr, andel, datum, kopeskilling, art, tomtratt (agare: tomträttsinnehav eller lagfart;
// saknas kolumnen sparas upplåtelseformen som okänd, aldrig som äganderätt)
// Rader med personnummer hoppas alltid över.
import { openDb, normOrgnr, normBeteckning, withTransaction, markPrivata } from '../lib/db.mjs';
import { loadMapped, parseArgs, num, isoDate } from '../lib/csv.mjs';

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
  tomtratt: ['tomtratt', 'tomtrattsinnehav', 'upplatelseform', 'inskrivningstyp', 'innehavstyp'],
};

const { rows, get, col } = loadMapped(file, FIELDS, args.map, ['beteckning', 'orgnr']);

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
    pris: num(get(r, 'kopeskilling')), art: get(r, 'art'),
    tomtratt: col.tomtratt == null ? null : /tomtr|^(1|j|ja|true)$/i.test(get(r, 'tomtratt') ?? '') ? 1 : 0 });
}
console.log(`${recs.length} rader att importera, ${personer} hoppade över (fysiska personer eller saknat org.nr).`);
if (args.dry) { console.log('Exempel:', recs.slice(0, 3)); process.exit(0); }

const db = openDb();
withTransaction(db, () => {
  if (som === 'agare') {
    if (!args.append) db.exec('DELETE FROM agande WHERE demo = 0');
    const ins = db.prepare('INSERT INTO agande (beteckning, orgnr, andel, inskrivningsdag, tomtratt, demo) VALUES (?, ?, ?, ?, ?, 0)');
    for (const r of recs) ins.run(r.bet, r.orgnr, r.andel, r.datum, r.tomtratt);
    markPrivata(db, privata);
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
