// Gemensam databas (node:sqlite, inga externa beroenden).
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { kommunAv, kommunForst } from './kommuner.mjs';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const DB_PATH = process.env.FASTIGHETSKARTA_DB ?? join(ROOT, 'data', 'fastighetskarta.sqlite');

const SCHEMA = `
-- Juridiska personer från Bolagsverket + SCB (värdefulla datamängder).
-- Enskilda näringsidkare (personnummer) importeras aldrig.
CREATE TABLE IF NOT EXISTS bolag (
  orgnr         TEXT PRIMARY KEY,      -- 10 siffror utan bindestreck
  namn          TEXT NOT NULL,
  jurform       TEXT,                  -- SCB-kod, t.ex. 49 = aktiebolag
  status        TEXT,                  -- SCB Ftgstat
  sni           TEXT,                  -- huvudsaklig SNI-kod
  adress        TEXT,
  postnr        TEXT,
  postort       TEXT,
  registrerad   TEXT,
  avregistrerad TEXT,
  verksamhet    TEXT,
  demo          INTEGER NOT NULL DEFAULT 0,
  agarkontroll  TEXT                   -- SCB:s ägarkontroll: stat, kommun, region, privat, privat_koncern, utland
);
CREATE INDEX IF NOT EXISTS bolag_demo ON bolag(demo) WHERE demo = 1;
CREATE INDEX IF NOT EXISTS bolag_namn ON bolag(namn);   -- pressmeddelandets utgivare → bolag (server.mjs)

-- Fastighetsindelning (Lantmäteriet). geojson i WGS84.
CREATE TABLE IF NOT EXISTS fastighet (
  beteckning TEXT PRIMARY KEY,         -- t.ex. "STOCKHOLM KLARA 1"
  kommun     TEXT,
  areal_m2   REAL,
  geojson    TEXT NOT NULL,            -- geometri (Polygon/MultiPolygon)
  minx REAL, miny REAL, maxx REAL, maxy REAL,  -- bbox för kartutsnitt
  kalla      TEXT NOT NULL,            -- 'lantmateriet' | 'demo'
  demo       INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS fastighet_bbox ON fastighet(minx, maxx, miny, maxy);

-- Taxeringsuppgifter (Skatteverket).
CREATE TABLE IF NOT EXISTS taxering (
  beteckning      TEXT NOT NULL,
  taxeringsenhet  TEXT,
  typ             TEXT,
  ar              INTEGER,
  varde_tkr       INTEGER,
  markvarde_tkr   INTEGER,
  byggvarde_tkr   INTEGER,
  agare_orgnr     TEXT,
  andel           TEXT,
  demo            INTEGER NOT NULL DEFAULT 0
);
-- (beteckning, ar): "senaste årets värde" blir en indexsökning i stället för en skanning.
DROP INDEX IF EXISTS taxering_bet;
CREATE INDEX IF NOT EXISTS taxering_bet_ar ON taxering(beteckning, ar);
CREATE INDEX IF NOT EXISTS taxering_agare ON taxering(agare_orgnr);

-- Lagfarna ägare och tomträttshavare (Lantmäteriet).
CREATE TABLE IF NOT EXISTS agande (
  beteckning      TEXT NOT NULL,
  orgnr           TEXT NOT NULL,
  andel           TEXT,
  inskrivningsdag TEXT,
  demo            INTEGER NOT NULL DEFAULT 0,
  tomtratt        INTEGER              -- 1 = tomträttsinnehav, 0 = lagfart, null = okänt (källan säger inget)
);
CREATE INDEX IF NOT EXISTS agande_bet ON agande(beteckning);
CREATE INDEX IF NOT EXISTS agande_orgnr ON agande(orgnr);

-- Fastigheter där någon ägare är en fysisk person. Bara beteckningen sparas (aldrig
-- vem), och används enbart för att utesluta fastigheten ur den publika databasen.
CREATE TABLE IF NOT EXISTS har_privat_agare (
  beteckning TEXT NOT NULL,
  kalla TEXT NOT NULL DEFAULT 'okand',
  PRIMARY KEY (beteckning, kalla)
);

-- Adresspunkter för sökning (OpenStreetMap nu, Lantmäteriets belägenhetsadresser senare).
-- Fastigheten för en adress hittas genom att punkten slås upp mot fastighetsytorna.
CREATE TABLE IF NOT EXISTS adress (
  id      INTEGER PRIMARY KEY,
  gata    TEXT NOT NULL,
  nummer  TEXT NOT NULL,
  postnr  TEXT,
  ort     TEXT,
  lon     REAL NOT NULL,
  lat     REAL NOT NULL,
  kalla   TEXT NOT NULL            -- 'osm' | 'lantmateriet'
);
CREATE INDEX IF NOT EXISTS adress_lonlat ON adress(lon, lat);
CREATE INDEX IF NOT EXISTS adress_gata ON adress(gata COLLATE NOCASE, nummer);

-- Fastighetsaffärer i pressmeddelanden (import-nyheter). Bara fakta och länken, aldrig texten,
-- och inga namn på privatpersoner.
CREATE TABLE IF NOT EXISTS nyhet (
  url      TEXT PRIMARY KEY,
  kalla    TEXT NOT NULL,            -- 'cision'
  utgivare TEXT NOT NULL,            -- bolaget som gav ut pressmeddelandet
  rubrik   TEXT NOT NULL,
  datum    TEXT,                     -- ISO 8601
  typ      TEXT NOT NULL,            -- 'kop' | 'salj'
  pris_kr  INTEGER,                  -- enligt pressmeddelandet
  kommun   TEXT,
  aktor_orgnr TEXT                   -- tidningar: den som köper eller säljer, när namnet är ett registrerat bolag (aktorBolag)
);
CREATE INDEX IF NOT EXISTS nyhet_datum ON nyhet(datum);
CREATE INDEX IF NOT EXISTS nyhet_affar ON nyhet(typ, pris_kr, datum);   -- samma affär i flera källor (server.mjs)
-- Platser i pressmeddelandet: kandidatbeteckning (slås upp mot fastighet när den finns) och/eller
-- en adresspunkt med fastigheten under punkten.
CREATE TABLE IF NOT EXISTS nyhet_plats (
  url        TEXT NOT NULL,
  beteckning TEXT,
  adress     TEXT,
  lon REAL, lat REAL
);
CREATE INDEX IF NOT EXISTS nyhet_plats_url ON nyhet_plats(url);
CREATE INDEX IF NOT EXISTS nyhet_plats_bet ON nyhet_plats(beteckning);

-- Överlåtelser med köpeskilling (Lantmäteriet).
CREATE TABLE IF NOT EXISTS transaktion (
  beteckning       TEXT NOT NULL,
  inskrivningsdag  TEXT,
  kopeskilling_kr  INTEGER,
  forvarvare_orgnr TEXT,
  art              TEXT,
  andel            TEXT,
  demo             INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS transaktion_bet ON transaktion(beteckning);
CREATE INDEX IF NOT EXISTS transaktion_orgnr ON transaktion(forvarvare_orgnr);

-- Arbetsställen (SCB:s företagsregister): företag med verksamhet på adressen, inte hyresavtal.
-- Bara juridiska personer och verksamma. Reklamspärr markeras (SCB:s villkor: informera om spärren). Fastigheten bestäms vid importen
-- med punkt-i-polygon (null = ingen fastighet i Horos på punkten).
CREATE TABLE IF NOT EXISTS arbetsstalle (
  cfar       INTEGER PRIMARY KEY,      -- SCB:s id för arbetsstället
  orgnr      TEXT NOT NULL,
  benamning  TEXT,                     -- arbetsställets populärnamn, ofta tomt
  sni        TEXT,                     -- primär näringsgren, SNI 2025 (5 siffror)
  avdelning  TEXT,                     -- SNI-avdelning (bokstav)
  bransch    TEXT,                     -- klartext för sni
  anstkl     INTEGER,                  -- storleksklass anställda (SCB:s kod 0–16)
  adress     TEXT,
  postnr     TEXT,
  ort        TEXT,
  lon REAL, lat REAL,
  beteckning TEXT,
  demo       INTEGER NOT NULL DEFAULT 0,
  lokaltyp   TEXT,                     -- se lib/lokaltyp.mjs, räknas vid importen
  loa_m2     REAL,                     -- uppskattad LOA, likaså
  reklamsparr INTEGER NOT NULL DEFAULT 0 -- 1 = har frånsagt sig reklam (post, e-post, telefon)
);
CREATE INDEX IF NOT EXISTS arbetsstalle_bet ON arbetsstalle(beteckning);
CREATE INDEX IF NOT EXISTS arbetsstalle_orgnr ON arbetsstalle(orgnr);

-- Detaljplaner och äldre planer (Lantmäteriet, Markreglerande bestämmelse). geojson i WGS84.
CREATE TABLE IF NOT EXISTS plan (
  id      TEXT PRIMARY KEY,          -- objektidentitet i Lantmäteriets fil
  typ     TEXT NOT NULL,             -- DP, ÄDP, SPL, BPL, OB, ÄOB, FP, TI, APL, GPL
  planid  TEXT,                      -- planens beteckning (akt)
  namn    TEXT,
  datum   TEXT,                      -- laga kraft (ÅÅÅÅ-MM-DD)
  kommun  TEXT,
  geojson TEXT NOT NULL,
  minx REAL, miny REAL, maxx REAL, maxy REAL,
  demo    INTEGER NOT NULL DEFAULT 0,
  kalla   TEXT NOT NULL DEFAULT 'lantmateriet',
  status  TEXT
);

-- Potentiellt förorenade områden (länsstyrelsernas EBH-stöd, CC BY 4.0). Punkter utan fastighetsbeteckning.
CREATE TABLE IF NOT EXISTS fororenat (
  ebh_id     INTEGER PRIMARY KEY,
  kommun     TEXT,
  bransch    TEXT,                   -- primär bransch
  bransch2   TEXT,                   -- sekundära branscher
  status     TEXT,                   -- Identifiering, Inventering, ...
  riskklass  INTEGER,                -- MIFO 1 (mycket stor risk) – 4 (liten risk), null = ej klassad
  lon REAL NOT NULL, lat REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS fororenat_lonlat ON fororenat(lon, lat);

-- Polisens utsatta områden (lägesbild). geojson i WGS84.
CREATE TABLE IF NOT EXISTS utsatt_omrade (
  id          INTEGER PRIMARY KEY,
  namn        TEXT NOT NULL,
  kategori    TEXT NOT NULL,         -- Utsatt område, Särskilt utsatt område (ev. riskområde)
  ort         TEXT,
  polisomrade TEXT,
  datum       TEXT,                  -- med i lägesbilden sedan
  geojson     TEXT NOT NULL
);
`;

export function openDb({ path = DB_PATH, readOnly = false } = {}) {
  if (readOnly) return new DatabaseSync(path, { readOnly: true });
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
  db.exec(SCHEMA);
  // Kolumner som tillkommit efter att tabellen skapades. De står sist i CREATE TABLE, så att SELECT *
  // (build-public) ger samma ordning i gamla och nya databaser.
  for (const [tabell, kolumn, typ] of [['agande', 'tomtratt', 'INTEGER'], ['arbetsstalle', 'lokaltyp', 'TEXT'], ['arbetsstalle', 'loa_m2', 'REAL'],
    ['arbetsstalle', 'reklamsparr', 'INTEGER NOT NULL DEFAULT 0'], ['bolag', 'agarkontroll', 'TEXT'], ['nyhet', 'aktor_orgnr', 'TEXT'],
    ['plan', 'kalla', "TEXT NOT NULL DEFAULT 'lantmateriet'"], ['plan', 'status', 'TEXT']]) {
    if (!hasColumn(db, tabell, kolumn)) db.exec(`ALTER TABLE ${tabell} ADD COLUMN ${kolumn} ${typ}`);
  }
  if (!hasColumn(db, 'har_privat_agare', 'kalla')) withTransaction(db, () => db.exec(`
    ALTER TABLE har_privat_agare RENAME TO gamla_privata;
    CREATE TABLE har_privat_agare (beteckning TEXT NOT NULL, kalla TEXT NOT NULL DEFAULT 'okand', PRIMARY KEY (beteckning, kalla));
    INSERT INTO har_privat_agare (beteckning) SELECT beteckning FROM gamla_privata;
    DROP TABLE gamla_privata;`));
  return db;
}

export const hasColumn = (db, tabell, kolumn) =>
  !!db.prepare('SELECT 1 FROM pragma_table_info(?) WHERE name = ?').get(tabell, kolumn);

// Normaliserar organisationsnummer till 10 siffror. Returnerar null för
// personnummer (enskilda näringsidkare): juridiska personer har 3:e siffran >= 2.
export function normOrgnr(raw) {
  if (!raw) return null;
  let d = String(raw).replace(/\D/g, '');
  if (d.length === 12) d = d.slice(2);  // sekelsiffror, t.ex. 16556...
  if (d.length !== 10) return null;
  if (Number(d[2]) < 2) return null;
  return d;
}

export function normBeteckning(raw) {
  return String(raw ?? '').trim().replace(/\s+/g, ' ').toUpperCase();
}

// Importer kräver kommunen i identiteten; okända eller motstridiga kommuner avvisas.
export function fastighetsBet(raw, kommun) {
  const bet = normBeteckning(raw), forst = kommunForst(bet);
  const k = kommunAv(kommun) ?? forst?.kommun;
  if (!k || !bet || (kommun && !kommunAv(kommun)) || (forst && forst.kommun !== k)) {
    throw new Error('Beteckningen kräver en entydig kommun');
  }
  return normBeteckning(`${k} ${forst ? forst.resten : bet}`);
}

export function geomBbox(geom) {
  let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
  const walk = (c) => {
    if (typeof c[0] === 'number') {
      if (c[0] < minx) minx = c[0];
      if (c[0] > maxx) maxx = c[0];
      if (c[1] < miny) miny = c[1];
      if (c[1] > maxy) maxy = c[1];
    } else c.forEach(walk);
  };
  walk(geom.coordinates);
  return { minx, miny, maxx, maxy };
}

// Tabellerna med en demo-kolumn (exempeldata).
export const DATA_TABLES = ['bolag', 'fastighet', 'taxering', 'agande', 'transaktion', 'plan', 'arbetsstalle'];

// SQL-villkor: fastigheten f har minst en känd juridisk ägare (lagfart eller taxering).
// Samma regel används av build-public (urvalet) och av serverns spärr i publikt läge.
export const harJuridiskAgare = ({ schema = '', extra = '' } = {}) =>
  `(EXISTS (SELECT 1 FROM ${schema}agande k WHERE k.beteckning = f.beteckning ${extra})
    OR EXISTS (SELECT 1 FROM ${schema}taxering k WHERE k.beteckning = f.beteckning AND k.agare_orgnr IS NOT NULL ${extra}))`;

// SQL-villkor: en plats i ett pressmeddelande (nyhet_plats) som inte får visas publikt, dvs. utan fastighet
// i databasen (en lös adresspunkt eller en okänd beteckning). Samma regel i build-public, import-nyheter
// (--publik, --behall) och serverns spärr i publikt läge.
export const NYHET_PLATS_UTANFOR = '(beteckning IS NULL OR beteckning NOT IN (SELECT beteckning FROM fastighet))';

// Markerar fastigheter med privat ägare (bara beteckningen, aldrig vem).
export function markPrivata(db, beteckningar, kalla = 'okand', juridiska = []) {
  // Bara ett fullständigt ägaruttag från samma källa får häva skyddet. Äldre okända källor ligger kvar.
  const privata = new Set(beteckningar);
  const del = db.prepare('DELETE FROM har_privat_agare WHERE beteckning = ? AND kalla = ?');
  for (const b of juridiska) if (!privata.has(b)) del.run(b, kalla);
  const ins = db.prepare('INSERT OR IGNORE INTO har_privat_agare (beteckning, kalla) VALUES (?, ?)');
  for (const b of beteckningar) if (b) ins.run(b, kalla);
}

// Fulltextindex för bolagsnamn. Externt innehåll utan triggers, så det byggs om efter
// varje ändring i bolag. prefix='2 3' gör korta prefixsökningar ("ab"*) snabba.
export function rebuildBolagFts(db) {
  db.exec(`DROP TABLE IF EXISTS bolag_fts;
    CREATE VIRTUAL TABLE bolag_fts USING fts5(namn, content='bolag', content_rowid='rowid', prefix='2 3');
    INSERT INTO bolag_fts(bolag_fts) VALUES('rebuild');`);
}

// Fulltextindex för adresser ("drottninggatan 53 111 21 stockholm"), byggs om efter import.
export function rebuildAdressFts(db) {
  db.exec(`DROP TABLE IF EXISTS adress_fts;
    CREATE VIRTUAL TABLE adress_fts USING fts5(gata, nummer, postnr, ort, content='adress', content_rowid='id', prefix='2 3');
    INSERT INTO adress_fts(adress_fts) VALUES('rebuild');`);
}

export function rebuildFastighetFts(db) {
  db.exec(`DROP TABLE IF EXISTS fastighet_fts;
    CREATE VIRTUAL TABLE fastighet_fts USING fts5(beteckning, content='fastighet', content_rowid='rowid', prefix='2 3');
    INSERT INTO fastighet_fts(fastighet_fts) VALUES('rebuild');`);
}

// Rumsligt index (R-träd) över tabellens bbox-kolumner, med tabellens rowid som id. Byggs om
// efter import: INSERT OR REPLACE ger raderna nya rowid.
export function rebuildRtree(db, table) {
  db.exec(`DROP TABLE IF EXISTS ${table}_rtree;
    CREATE VIRTUAL TABLE ${table}_rtree USING rtree(id, minx, maxx, miny, maxy);
    INSERT INTO ${table}_rtree SELECT rowid, minx, maxx, miny, maxy FROM ${table} WHERE minx IS NOT NULL;`);
}

export function withTransaction(db, fn) {
  db.exec('BEGIN');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}
