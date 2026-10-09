// Gemensam databas (node:sqlite, inga externa beroenden).
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

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
  demo          INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS bolag_demo ON bolag(demo) WHERE demo = 1;

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

-- Lagfarna ägare (Lantmäteriet).
CREATE TABLE IF NOT EXISTS agande (
  beteckning      TEXT NOT NULL,
  orgnr           TEXT NOT NULL,
  andel           TEXT,
  inskrivningsdag TEXT,
  demo            INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS agande_bet ON agande(beteckning);
CREATE INDEX IF NOT EXISTS agande_orgnr ON agande(orgnr);

-- Fastigheter där någon ägare är en fysisk person. Bara beteckningen sparas (aldrig
-- vem), och används enbart för att utesluta fastigheten ur den publika databasen.
CREATE TABLE IF NOT EXISTS har_privat_agare (
  beteckning TEXT PRIMARY KEY
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
  demo    INTEGER NOT NULL DEFAULT 0
);
`;

export function openDb({ path = DB_PATH, readOnly = false } = {}) {
  if (readOnly) return new DatabaseSync(path, { readOnly: true });
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
  db.exec(SCHEMA);
  return db;
}

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
export const DATA_TABLES = ['bolag', 'fastighet', 'taxering', 'agande', 'transaktion', 'plan'];

// SQL-villkor: fastigheten f har minst en känd juridisk ägare (lagfart eller taxering).
// Samma regel används av build-public (urvalet) och av serverns spärr i publikt läge.
export const harJuridiskAgare = ({ schema = '', extra = '' } = {}) =>
  `(EXISTS (SELECT 1 FROM ${schema}agande k WHERE k.beteckning = f.beteckning ${extra})
    OR EXISTS (SELECT 1 FROM ${schema}taxering k WHERE k.beteckning = f.beteckning AND k.agare_orgnr IS NOT NULL ${extra}))`;

// Markerar fastigheter med privat ägare (bara beteckningen, aldrig vem).
export function markPrivata(db, beteckningar) {
  const ins = db.prepare('INSERT OR IGNORE INTO har_privat_agare (beteckning) VALUES (?)');
  for (const b of beteckningar) if (b) ins.run(b);
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
