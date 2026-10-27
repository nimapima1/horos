// Importerar taxeringsuppgifter från Skatteverkets utlämnade fil (Excel .xlsx eller CSV).
// Kolumnerna gissas via synonymer.
// Kör först med --dry för att se vilka kolumner som hittades.
//
//   node scripts/import-taxering.mjs data/raw/taxering.xlsx [--dry] [--enhet kr|tkr] [--fullstandigt] [--kommun namn|kod] [--map fält=kolumn ...]
//
// Fält: beteckning, taxeringsenhet, typ, ar, varde, markvarde, byggvarde, orgnr, andel
// Rader där ägaren inte är en juridisk person (personnummer) hoppas över. Typkoder (t.ex. 325)
// sparas som Skatteverkets klartext för taxeringsåret, se lib/typkoder.mjs.
import { openDb, normOrgnr, fastighetsBet, withTransaction, markPrivata } from '../lib/db.mjs';
import { loadMapped, parseArgs, num } from '../lib/csv.mjs';
import { typText } from '../lib/typkoder.mjs';

const args = parseArgs(process.argv.slice(2));
const file = args._[0];
if (!file) { console.error('Ange CSV-fil. Se kommentaren överst i skriptet.'); process.exit(1); }

const FIELDS = {
  beteckning: ['fastighetsbeteckning', 'beteckning', 'fastighet', 'registerbeteckning'],
  kommun: ['kommunnamn', 'kommunkod', 'kommun'],
  lan: ['lanskod', 'lan'],
  taxeringsenhet: ['taxeringsenhetsnummer', 'taxeringsenhet', 'tenr', 'taxenhet'],
  typ: ['typkod', 'taxeringsenhetstyp', 'typ'],
  ar: ['taxeringsar', 'ar', 'taxar'],
  varde: ['taxeringsvarde', 'totaltaxeringsvarde', 'tax_varde', 'varde'],
  markvarde: ['markvarde', 'tomtvarde', 'markvärde'],
  byggvarde: ['byggnadsvarde', 'byggvarde', 'byggnadsvärde'],
  orgnr: ['organisationsnummer', 'orgnr', 'agareid', 'agaresidentitet', 'personorganisationsnummer', 'idnummer'],
  andel: ['agarandel', 'andel'],
};

const { rows, get, col, header } = loadMapped(file, FIELDS, args.map, ['beteckning', 'varde']);

const rubrik = header[col.varde];
const enheter = (rubrik.match(/(?<!\p{L})(?:tkr|kr)(?!\p{L})/giu) ?? []).map((s) => s.toLowerCase());
const enhet = args.enhet ?? (new Set(enheter).size === 1 ? enheter[0] : null);
if (!['kr', 'tkr'].includes(enhet)) throw new Error('Ange --enhet kr|tkr när värdekolumnen inte anger enheten.');
const toTkr = (v) => (v == null ? null : Math.round(enhet === 'kr' ? v / 1000 : v));
console.log(`Värden tolkas som ${enhet}.`);

// Skatteverkets uttag (2026): länskod och kommunkod i var sin kolumn ("1", "14" -> "0114"), och "M.FL" efter
// beteckningen när taxeringsenheten omfattar flera fastigheter (värdet hamnar på den som står först).
// Beteckningen har då aldrig kommunen först.
const bet = (r) => {
  const lan = get(r, 'lan'), k = get(r, 'kommun'), b = get(r, 'beteckning')?.replace(/\s+M\.?\s?FL\.?$/i, '');
  return lan && /^\d{1,2}$/.test(k ?? '')
    ? fastighetsBet(b, lan.padStart(2, '0') + k.padStart(2, '0'), { utanKommun: true })
    : fastighetsBet(b, k ?? args.kommun);
};

let personer = 0;
const okanda = new Set();
const recs = [];
const privata = new Set();
for (const r of rows) {
  const orgnrRaw = get(r, 'orgnr');
  const orgnr = normOrgnr(orgnrRaw);
  if (orgnrRaw && !orgnr) {                              // personnummer: spara aldrig
    personer++;
    privata.add(bet(r));   // bara beteckningen, för uteslutning
    continue;
  }
  const ar = num(get(r, 'ar'));
  const typ = get(r, 'typ'), text = typText(typ, ar);
  if (/^\d{3}$/.test(typ ?? '') && text === typ) okanda.add(typ);   // kod som inte finns i listan
  recs.push([bet(r), get(r, 'taxeringsenhet'), text, ar,
    toTkr(num(get(r, 'varde'))), toTkr(num(get(r, 'markvarde'))), toTkr(num(get(r, 'byggvarde'))), orgnr, get(r, 'andel')]);
}
console.log(`${recs.length} rader att importera, ${personer} hoppade över (fysiska personer).`);
if (okanda.size) console.log(`Okända typkoder (sparas som kod, lägg till i lib/typkoder.mjs): ${[...okanda].sort().join(', ')}`);
if (args.dry) { console.log('Exempel:', recs.slice(0, 3)); process.exit(0); }

const db = openDb();
const ins = db.prepare(`INSERT INTO taxering (beteckning, taxeringsenhet, typ, ar, varde_tkr, markvarde_tkr, byggvarde_tkr, agare_orgnr, andel, demo)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`);
withTransaction(db, () => {
  if (!args.append) db.exec('DELETE FROM taxering WHERE demo = 0');
  for (const r of recs) ins.run(...r);
  markPrivata(db, privata, 'taxering', args.fullstandigt === true && !args.append
    ? recs.filter((r) => r[7]).map((r) => r[0]) : []);
});
const { utan } = db.prepare(`SELECT count(DISTINCT t.beteckning) AS utan FROM taxering t
  LEFT JOIN fastighet f ON f.beteckning = t.beteckning WHERE t.demo = 0 AND f.beteckning IS NULL`).get();
console.log(`Klart. ${utan} beteckningar saknar karta (importera Fastighetsindelning, eller kontrollera att beteckningarna skrivs likadant).`);
