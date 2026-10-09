// Importerar juridiska personer från Bolagsverkets och SCB:s bulkfiler
// (värdefulla datamängder, avgiftsfria). Hämta filerna från
// https://bolagsverket.se/apierochoppnadata/hamtaforetagsinformation/nedladdningsbarafiler.2517.html
// och packa upp dem under data/raw/bv och data/raw/scb.
//
// Integritet: rader med personnummer (enskilda näringsidkare, dödsbon) hoppas
// över, och c/o-adresser sparas inte eftersom de ofta är namn på privatpersoner.
//
//   node scripts/import-bolag.mjs [--bv <fil>] [--scb <fil>]
import { createReadStream, readdirSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { openDb, normOrgnr, ROOT } from '../lib/db.mjs';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1]]] : acc), []),
);
const firstTxt = (dir) => {
  try { return join(dir, readdirSync(dir).find((f) => f.endsWith('.txt'))); } catch { return null; }
};
const BV_FILE = args.bv ?? firstTxt(join(ROOT, 'data', 'raw', 'bv'));
const SCB_FILE = args.scb ?? firstTxt(join(ROOT, 'data', 'raw', 'scb'));

const SCB_JURFORM = {
  21: 'Enkla bolag', 22: 'Partrederi', 23: 'Värdepappersfond', 31: 'Handelsbolag', 32: 'Kommanditbolag',
  41: 'Bankaktiebolag', 42: 'Försäkringsaktiebolag', 43: 'Europabolag', 49: 'Aktiebolag',
  51: 'Ekonomisk förening', 53: 'Bostadsrättsförening', 54: 'Kooperativ hyresrättsförening',
  55: 'Europakooperativ', 61: 'Ideell förening', 62: 'Samfällighet', 63: 'Registrerat trossamfund',
  71: 'Familjestiftelse', 72: 'Stiftelse', 81: 'Statlig enhet', 82: 'Kommun', 83: 'Kommunalförbund',
  84: 'Region', 85: 'Allmän försäkringskassa', 87: 'Offentlig korporation', 88: 'Hypoteksförening',
  89: 'Regional statlig myndighet', 92: 'Ömsesidigt försäkringsbolag', 93: 'Sparbank',
  94: 'Understödsförening', 95: 'Arbetslöshetskassa', 96: 'Utländsk juridisk person',
  98: 'Övrig svensk juridisk person', 99: 'Juridisk form ej utredd',
};
const BV_FORM = {
  AB: 'Aktiebolag', HB: 'Handelsbolag', KB: 'Kommanditbolag', BRF: 'Bostadsrättsförening',
  EK: 'Ekonomisk förening', FL: 'Filial', I: 'Ideell förening', S: 'Stiftelse', BF: 'Bostadsförening',
  KHF: 'Kooperativ hyresrättsförening', FAB: 'Försäkringsaktiebolag', OFB: 'Ömsesidigt försäkringsbolag',
  BAB: 'Bankaktiebolag', SB: 'Sparbank', EGTS: 'EGTS', EEIG: 'Europeisk ekonomisk intressegruppering',
  SE: 'Europabolag', SCE: 'Europakooperativ',
};

const db = openDb();

// --- SCB: juridisk form, SNI, status, adress (versaler) -----------------------
const upsertScb = db.prepare(`
  INSERT INTO bolag (orgnr, namn, jurform, status, sni, adress, postnr, postort, registrerad)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(orgnr) DO UPDATE SET
    jurform = excluded.jurform, status = excluded.status, sni = excluded.sni,
    namn = coalesce(bolag.namn, excluded.namn)`);

// --- Bolagsverket: firmanamn (rätt skiftläge), datum, verksamhet, adress -------
const upsertBv = db.prepare(`
  INSERT INTO bolag (orgnr, namn, jurform, adress, postnr, postort, registrerad, avregistrerad, verksamhet)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(orgnr) DO UPDATE SET
    namn = excluded.namn,
    jurform = coalesce(bolag.jurform, excluded.jurform),
    adress = coalesce(excluded.adress, bolag.adress),
    postnr = coalesce(excluded.postnr, bolag.postnr),
    postort = coalesce(excluded.postort, bolag.postort),
    registrerad = coalesce(excluded.registrerad, bolag.registrerad),
    avregistrerad = excluded.avregistrerad,
    verksamhet = excluded.verksamhet`);

const nz = (s) => (s && s.trim() ? s.trim() : null);
const isoDate = (s) => (/^\d{8}$/.test(s ?? '') ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6)}` : nz(s));

// Semikolonseparerad rad med "..."-fält och \" som escape.
function splitBv(line) {
  const out = [];
  let cur = '', inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQ) {
      if (c === '\\' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') inQ = false;
      else cur += c;
    } else if (c === '"') inQ = true;
    else if (c === ';') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

async function eachLine(file, encoding, onLine) {
  const rl = createInterface({ input: createReadStream(file, { encoding }), crlfDelay: Infinity });
  let n = 0, kept = 0, header = null;
  const BATCH = 20000;
  db.exec('BEGIN');
  for await (const line of rl) {
    if (!header) { header = line; continue; }
    if (onLine(line)) kept++;
    if (++n % BATCH === 0) {
      db.exec('COMMIT; BEGIN');
      process.stdout.write(`\r  ${n.toLocaleString('sv')} rader, ${kept.toLocaleString('sv')} juridiska personer`);
    }
  }
  db.exec('COMMIT');
  console.log(`\r  ${n.toLocaleString('sv')} rader, ${kept.toLocaleString('sv')} juridiska personer`);
}

if (SCB_FILE) {
  console.log(`SCB: ${SCB_FILE}`);
  await eachLine(SCB_FILE, 'latin1', (line) => {
    const c = line.split('\t');
    // ForAndrTyp COAdress Foretagsnamn FtgStat Gatuadress JEStat JurForm Namn Ng1..Ng5 PeOrgNr PostNr PostOrt RegDatKtid ...
    const jurform = Number(c[6]);
    if (jurform === 10 || jurform === 91) return false;     // enskild näringsidkare, dödsbo
    const orgnr = normOrgnr(c[13]);
    if (!orgnr) return false;
    upsertScb.run(orgnr, nz(c[2]) ?? nz(c[7]) ?? orgnr, SCB_JURFORM[jurform] ?? nz(c[6]), nz(c[3]), nz(c[8]),
      nz(c[4]), nz(c[14]), nz(c[15]), isoDate(c[16]));
    return true;
  });
} else console.warn('Ingen SCB-fil hittades i data/raw/scb – hoppar över.');

if (BV_FILE) {
  console.log(`Bolagsverket: ${BV_FILE}`);
  await eachLine(BV_FILE, 'utf8', (line) => {
    if (!line.includes('$ORGNR-IDORG')) return false;          // PERSON-IDORG = personnummer
    const c = splitBv(line);
    const orgnr = normOrgnr(c[0].split('$')[0]);
    if (!orgnr) return false;
    const huvudnamn = c[3].split('|').find((s) => s.includes('$FORETAGSNAMN-ORGNAM')) ?? c[3];
    const namn = nz(huvudnamn.split('$')[0]) ?? orgnr;
    const formKod = c[4].replace(/-ORGFO$/, '');
    // postadress: gata$c/o$ort$postnr$land (c/o sparas inte)
    const [gata, , ort, postnr] = (c[10] ?? '').split('$');
    upsertBv.run(orgnr, namn, BV_FORM[formKod] ?? nz(formKod), nz(gata), nz(postnr), nz(ort),
      nz(c[8]), nz(c[5]), nz(c[9])?.slice(0, 1000) ?? null);
    return true;
  });
} else console.warn('Ingen Bolagsverket-fil hittades i data/raw/bv – hoppar över.');

console.log('Bygger sökindex för bolagsnamn…');
db.exec(`DROP TABLE IF EXISTS bolag_fts;
  CREATE VIRTUAL TABLE bolag_fts USING fts5(namn, content='bolag', content_rowid='rowid');
  INSERT INTO bolag_fts(bolag_fts) VALUES('rebuild');`);

const { n } = db.prepare('SELECT count(*) AS n FROM bolag WHERE demo = 0').get();
console.log(`Klart: ${n.toLocaleString('sv')} juridiska personer i databasen.`);
