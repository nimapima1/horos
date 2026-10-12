// Pressmeddelanden i den publika databasen på servern: deploy --data behåller dem som cron hämtat
// (bara platser på fastigheter i den nya databasen), och publikt läge vägrar starta med en lös adresspunkt.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ROOT, openDb, rebuildRtree } from '../lib/db.mjs';

const DIR = join(ROOT, 'data', '_test');
const NY = join(DIR, 'nyheter-ny.sqlite');
const GAMMAL = join(DIR, 'nyheter-gammal.sqlite');
const node = (args, env = {}) => spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', ...args],
  { env: { ...process.env, ...env }, encoding: 'utf8', timeout: 20_000 });
const URL = (n) => `https://news.cision.com/se/a/r/${n}`;

// En publik databas som build-public gör den: en fastighet med juridisk ägare, ingen har_privat_agare.
function publik(path, sql) {
  for (const ext of ['', '-wal', '-shm', '-journal']) rmSync(path + ext, { force: true });
  const db = openDb({ path });
  db.exec(`DROP TABLE har_privat_agare;
    INSERT INTO fastighet (beteckning, kommun, geojson, minx, miny, maxx, maxy, kalla) VALUES
      ('T 1:1', 'Testkommun', '{}', 18, 59, 18.001, 59.001, 'lantmateriet');
    INSERT INTO agande (beteckning, orgnr) VALUES ('T 1:1', '5560000001');
    ${sql};
    PRAGMA journal_mode = DELETE;`);
  rebuildRtree(db, 'fastighet');   // som build-public
  db.close();
}

test('deploy --data: pressmeddelanden som bara finns på servern följer med, platser bara på fastigheter', () => {
  publik(GAMMAL, `INSERT INTO nyhet (url, kalla, utgivare, rubrik, typ) VALUES
      ('${URL(1)}', 'cision', 'Alfa', 'Från cron', 'kop'), ('${URL(2)}', 'cision', 'Alfa', 'Gammal rubrik', 'kop');
    INSERT INTO nyhet_plats (url, beteckning, adress, lon, lat) VALUES
      ('${URL(1)}', 'T 1:1', NULL, NULL, NULL), ('${URL(1)}', 'T 9:9', 'Gatan 1', 18.5, 59.5), ('${URL(2)}', 'T 1:1', NULL, NULL, NULL)`);
  publik(NY, `INSERT INTO nyhet (url, kalla, utgivare, rubrik, typ) VALUES ('${URL(2)}', 'cision', 'Alfa', 'Ny rubrik', 'kop')`);
  const r = node([join(ROOT, 'scripts', 'import-nyheter.mjs'), '--publik', NY, '--behall', GAMMAL]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Behöll 1 pressmeddelanden/);
  const db = openDb({ path: NY, readOnly: true });
  assert.deepEqual(db.prepare('SELECT url, rubrik FROM nyhet ORDER BY url').all().map((x) => ({ ...x })),
    [{ url: URL(1), rubrik: 'Från cron' }, { url: URL(2), rubrik: 'Ny rubrik' }]);
  assert.deepEqual(db.prepare('SELECT url, beteckning FROM nyhet_plats').all().map((x) => ({ ...x })),
    [{ url: URL(1), beteckning: 'T 1:1' }]);
  assert.ok(!db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'har_privat_agare'").get());
  db.close();
});

test('publikt läge vägrar starta med en plats i ett pressmeddelande utan fastighet i Horos', () => {
  publik(NY, `INSERT INTO nyhet (url, kalla, utgivare, rubrik, typ) VALUES ('${URL(3)}', 'cision', 'Alfa', 'Köp', 'kop');
    INSERT INTO nyhet_plats (url, beteckning, adress, lon, lat) VALUES ('${URL(3)}', NULL, 'Gatan 1', 18.5, 59.5)`);
  const r = node([join(ROOT, 'server.mjs')], { FASTIGHETSKARTA_DB: NY, PUBLIC_MODE: '1', PORT: '3019' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /1 platser i pressmeddelanden utan fastighet/);
});

test('cron --mfn: det MFN skickat förs in med källan mfn, platser bara på fastigheter', () => {
  const MFN = join(DIR, 'nyheter-mfn.sqlite');
  rmSync(MFN, { force: true });
  publik(NY, '');
  const m = new DatabaseSync(MFN);
  m.exec(`CREATE TABLE mfn_nyhet (url TEXT PRIMARY KEY, utgivare TEXT NOT NULL, rubrik TEXT NOT NULL, datum TEXT, typ TEXT NOT NULL,
      pris_kr INTEGER, kommun TEXT, beteckningar TEXT NOT NULL, adresser TEXT NOT NULL, mottagen TEXT NOT NULL);
    INSERT INTO mfn_nyhet VALUES ('${URL(4)}', 'Alfa AB', 'Alfa köper', '2026-10-12T06:00:00.000Z', 'kop', 50000000, 'Testkommun',
      '["T 1:1","T 9:9"]', '[]', '2026-10-12')`);
  m.close();
  const r = node([join(ROOT, 'scripts', 'import-nyheter.mjs'), '--publik', NY, '--mfn', MFN]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(node([join(ROOT, 'scripts', 'import-nyheter.mjs'), '--publik', NY, '--mfn', MFN]).status, 3);   // inget nytt
  const db = openDb({ path: NY, readOnly: true });
  assert.deepEqual({ ...db.prepare('SELECT url, kalla, utgivare, pris_kr FROM nyhet').get() },
    { url: URL(4), kalla: 'mfn', utgivare: 'Alfa AB', pris_kr: 50000000 });
  assert.deepEqual(db.prepare('SELECT beteckning FROM nyhet_plats').all().map((x) => x.beteckning), ['T 1:1']);
  db.close();
});
