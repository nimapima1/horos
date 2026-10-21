// build-public: pressmeddelandenas platser får bara följa med för tillåtna fastigheter (juridisk ägare,
// ingen privat ägare), aldrig som en adress utan fastighet i Horos. Åtagandena i ansökan till Lantmäteriet.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, openDb } from '../lib/db.mjs';

const SRC = join(ROOT, 'data', '_test', 'bp-src.sqlite');
const OUT = join(ROOT, 'data', '_test', 'bp-pub.sqlite');

test('nyhet_plats: bara tillåtna fastigheter blir publika', () => {
  for (const f of [SRC, OUT]) for (const ext of ['', '-wal', '-shm']) rmSync(f + ext, { force: true });
  const src = openDb({ path: SRC });
  src.exec(`INSERT INTO bolag (orgnr, namn) VALUES ('5560000001', 'Alfa AB');
    INSERT INTO fastighet (beteckning, kommun, geojson, minx, miny, maxx, maxy, kalla) VALUES
      ('T 1:1', 'Testkommun', '{}', 18, 59, 18.001, 59.001, 'lantmateriet'),
      ('T 1:2', 'Testkommun', '{}', 18, 59, 18.001, 59.001, 'lantmateriet');
    INSERT INTO agande (beteckning, orgnr) VALUES ('T 1:1', '5560000001'), ('T 1:2', '5560000001');
    INSERT INTO har_privat_agare (beteckning) VALUES ('T 1:2');
    INSERT INTO transaktion (beteckning, inskrivningsdag, kopeskilling_kr, forvarvare_orgnr, art, andel) VALUES
      ('T 1:1', '2018-01-01', 1000000, '5560000001', 'Köp', '1/1'),
      ('T 1:1', '2020-01-01', 2000000, NULL, 'Privat köp', '1/2');
    INSERT INTO nyhet (url, kalla, utgivare, rubrik, typ) VALUES ('https://news.cision.com/se/a/r/1', 'cision', 'Alfa', 'Alfa köper från privatpersonen Test Testsson', 'kop');
    INSERT INTO nyhet_plats (url, beteckning, adress, lon, lat) VALUES
      ('https://news.cision.com/se/a/r/1', 'T 1:1', NULL, NULL, NULL),
      ('https://news.cision.com/se/a/r/1', 'T 1:2', 'Privatgatan 1', 18.0005, 59.0005),
      ('https://news.cision.com/se/a/r/1', 'FINNS INTE 1', NULL, NULL, NULL),
      ('https://news.cision.com/se/a/r/1', NULL, 'Testgatan 1', 18.5, 59.5),
      ('https://news.cision.com/se/a/r/1', NULL, NULL, NULL, NULL)`);
  const plan = src.prepare(`INSERT INTO plan (id, typ, geojson, kalla, status) VALUES (?, 'DP', '{}', ?, ?)`);
  plan.run('ngp-gallande', 'ngp', 'laga kraft');
  plan.run('ngp-forslag', 'ngp', 'samråd');
  plan.run('ngp-arkiv', 'ngp', 'arkiverad');
  plan.run('licensplan', 'lantmateriet', null);
  src.close();
  execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', join(ROOT, 'scripts', 'build-public.mjs'),
    '--lm-beslut', 'TEST', '--out', OUT], { env: { ...process.env, FASTIGHETSKARTA_DB: SRC }, stdio: 'pipe' });
  const pub = openDb({ path: OUT, readOnly: true });
  try {
    assert.deepEqual(pub.prepare('SELECT id FROM plan ORDER BY id').all().map((p) => p.id), ['ngp-forslag', 'ngp-gallande']);
    assert.deepEqual({ ...pub.prepare('SELECT inskrivningsdag, kopeskilling_kr, art, andel FROM transaktion WHERE forvarvare_orgnr IS NULL').get() },
      { inskrivningsdag: '2020-01-01', kopeskilling_kr: null, art: null, andel: null });
    assert.equal(pub.prepare('SELECT kopeskilling_kr FROM transaktion WHERE forvarvare_orgnr IS NOT NULL').get().kopeskilling_kr, 1000000);
    assert.equal(pub.prepare('SELECT count(*) AS n FROM nyhet').get().n, 1);
    assert.equal(pub.prepare('SELECT rubrik FROM nyhet').get().rubrik, 'Fastighetsköp');
    assert.equal(pub.prepare('SELECT url FROM nyhet').get().url, 'https://news.cision.com/se/a/r/1');
    assert.deepEqual(pub.prepare('SELECT beteckning, adress FROM nyhet_plats').all().map((r) => ({ ...r })),
      [{ beteckning: 'T 1:1', adress: null }]);
  } finally {
    pub.close();
  }
});
