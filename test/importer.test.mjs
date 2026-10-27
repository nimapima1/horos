import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ROOT, openDb, fastighetsBet, markPrivata } from '../lib/db.mjs';

const DIR = join(ROOT, 'data', '_test');
mkdirSync(DIR, { recursive: true });
const dbfil = (namn) => {
  const fil = join(DIR, 'import-' + namn + '.sqlite');
  for (const ext of ['', '-wal', '-shm']) rmSync(fil + ext, { force: true });
  return fil;
};
const csv = (namn, text) => {
  const fil = join(DIR, 'import-' + namn + '.csv');
  writeFileSync(fil, text);
  return fil;
};
const kor = (skript, db, ...args) => spawnSync(process.execPath,
  ['--disable-warning=ExperimentalWarning', join(ROOT, 'scripts', skript + '.mjs'), ...args],
  { env: { ...process.env, FASTIGHETSKARTA_DB: db }, encoding: 'utf8', timeout: 10000 });
const ok = (r) => assert.equal(r.status, 0, r.stderr);

function polygon(x) {
  const ring = [[x, 6580000], [x + 100, 6580000], [x + 100, 6580100], [x, 6580100], [x, 6580000]];
  const b = Buffer.alloc(21 + ring.length * 16);
  b.write('GP'); b[3] = 1; b.writeInt32LE(3006, 4);
  b[8] = 1; b.writeUInt32LE(3, 9); b.writeUInt32LE(1, 13); b.writeUInt32LE(ring.length, 17);
  ring.forEach(([x, y], i) => { b.writeDoubleLE(x, 21 + i * 16); b.writeDoubleLE(y, 29 + i * 16); });
  return b;
}

test('fastigheter: kommun gör identiteten entydig; --dry skapar eller ändrar ingen databas', () => {
  const fil = join(DIR, 'fastigheter-regression.gpkg'), DB = dbfil('fastighet');
  rmSync(fil, { force: true });
  const g = new DatabaseSync(fil);
  g.exec("CREATE TABLE gpkg_contents (table_name, data_type, srs_id); CREATE TABLE gpkg_geometry_columns (table_name, column_name, geometry_type_name);"
    + "INSERT INTO gpkg_contents VALUES ('fastighetsyta', 'features', 3006); INSERT INTO gpkg_geometry_columns VALUES ('fastighetsyta', 'geom', 'POLYGON');"
    + 'CREATE TABLE fastighetsyta (beteckning, kommunkod, geom BLOB)');
  const ins = g.prepare('INSERT INTO fastighetsyta VALUES (?, ?, ?)');
  ins.run('PILEN 1', '0180', polygon(674000)); ins.run('PILEN 1', '0184', polygon(674200));
  g.close();
  ok(kor('import-fastigheter', DB, fil, '--dry'));
  for (const ext of ['', '-wal', '-shm']) assert.equal(existsSync(DB + ext), false);
  ok(kor('import-fastigheter', DB, fil));
  const fore = readFileSync(DB);
  ok(kor('import-fastigheter', DB, fil, '--dry'));
  assert.deepEqual(readFileSync(DB), fore);
  const db = openDb({ path: DB, readOnly: true });
  const rows = db.prepare('SELECT beteckning, kommun, geojson FROM fastighet ORDER BY beteckning').all();
  assert.deepEqual(rows.map((r) => [r.beteckning, r.kommun]), [['SOLNA PILEN 1', 'Solna'], ['STOCKHOLM PILEN 1', 'Stockholm']]);
  assert.notEqual(rows[0].geojson, rows[1].geojson);
  db.close();
  assert.equal(fastighetsBet(' Stockholm  Pilen 1 ', '180'), 'STOCKHOLM PILEN 1');
  assert.throws(() => fastighetsBet('Pilen 1'), /kommun/);
  assert.throws(() => fastighetsBet('Solna Pilen 1', 'Stockholm'), /kommun/);
  // Traktnamn som också är kommuner, när källan har kommunen i en egen kolumn (Skatteverket, Fastighetsindelning).
  assert.equal(fastighetsBet('Vallentuna Prästgård 1:144', '0115', { utanKommun: true }), 'VALLENTUNA VALLENTUNA PRÄSTGÅRD 1:144');
  assert.equal(fastighetsBet('Berg 1:12', 'Värmdö', { utanKommun: true }), 'VÄRMDÖ BERG 1:12');
  assert.throws(() => fastighetsBet('Berg 1:12', null, { utanKommun: true }), /kommun/);
});

test('taxering och lagfart använder samma identitet i båda kommunerna', () => {
  const DB = dbfil('identitet');
  const fil = csv('identitet', 'Beteckning;Kommun;Orgnr;Taxeringsenhet;Varde;Ar\nPilen 1;Stockholm;5560000001;1;10000;2025\nPilen 1;Solna;5560000002;2;20000;2025');
  ok(kor('import-taxering', DB, fil, '--enhet', 'tkr'));
  ok(kor('import-lagfarter', DB, fil, '--som', 'agare'));
  const db = openDb({ path: DB, readOnly: true });
  for (const tabell of ['taxering', 'agande']) assert.deepEqual(db.prepare('SELECT beteckning FROM ' + tabell + ' ORDER BY beteckning').all().map((r) => r.beteckning), ['SOLNA PILEN 1', 'STOCKHOLM PILEN 1']);
  db.close();
});

test('taxering: okänd enhet och ogiltig flagga avvisas före skrivning, stora tkr gissas aldrig till kr', () => {
  const DB = dbfil('enhet'), fil = csv('enhet', 'Beteckning;Varde\nSTOCKHOLM PILEN 1;300000');
  for (const args of [[], ['--enhet', 'mkr']]) {
    const r = kor('import-taxering', DB, fil, ...args);
    assert.notEqual(r.status, 0); assert.match(r.stderr, /--enhet kr\|tkr/); assert.equal(existsSync(DB), false);
  }
  const tvetydig = csv('tvetydig', 'Beteckning;Varde (kr/tkr)\nSTOCKHOLM PILEN 1;300000');
  assert.notEqual(kor('import-taxering', DB, tvetydig).status, 0); assert.equal(existsSync(DB), false);
  ok(kor('import-taxering', DB, fil, '--enhet', 'tkr'));
  let db = openDb({ path: DB, readOnly: true });
  assert.equal(db.prepare('SELECT varde_tkr FROM taxering').get().varde_tkr, 300000); db.close();
  for (const [enhet, varde] of [['tkr', 300000], ['kr', 300], ['TKR', 300000]]) {
    const tydlig = csv('enhet', 'Beteckning;Taxeringsvarde (' + enhet + ')\nSTOCKHOLM PILEN 1;300000');
    ok(kor('import-taxering', DB, tydlig));
    db = openDb({ path: DB, readOnly: true });
    assert.equal(db.prepare('SELECT varde_tkr FROM taxering').get().varde_tkr, varde); db.close();
  }
});

test('privata överlåtelser ligger kvar anonymt mellan två juridiska förvärvare', () => {
  const DB = dbfil('historik');
  const fil = csv('historik', 'Beteckning;Kommun;Orgnr;Datum;Pris;Art;Andel;Namn\nPilen 1;Solna;5560000001;2018-01-01;1000000;Köp;1/1;Alfa\nPilen 1;Solna;199001011234;2020-01-01;2000000;Test Testsson 199001011234;199001011234;Test Testsson\nPilen 1;Solna;5560000002;2026-01-01;3000000;Köp;1/1;Beta');
  ok(kor('import-lagfarter', DB, fil));
  const db = openDb({ path: DB, readOnly: true });
  const rader = db.prepare('SELECT * FROM transaktion ORDER BY inskrivningsdag').all();
  assert.deepEqual(rader.map((r) => r.forvarvare_orgnr), ['5560000001', null, '5560000002']);
  assert.equal(rader[1].art, null); assert.equal(rader[1].andel, null);
  assert.equal(rader[1].kopeskilling_kr, 2000000);
  assert.doesNotMatch(JSON.stringify(rader), /Testsson|199001011234/);
  assert.equal(db.prepare('SELECT count(*) AS n FROM har_privat_agare').get().n, 0);
  db.close();
});

test('privatmarkering hävs bara av fullständigt juridiskt ägaruttag från samma källa', () => {
  const DB = dbfil('privatskydd'), bet = 'SOLNA PILEN 1';
  const privat = csv('privat', 'Beteckning;Orgnr;Varde\n' + bet + ';199001011234;10000');
  const juridisk = csv('juridisk', 'Beteckning;Orgnr;Varde\n' + bet + ';5560000001;10000');
  ok(kor('import-lagfarter', DB, privat, '--som', 'agare'));
  ok(kor('import-taxering', DB, privat, '--enhet', 'tkr'));
  const kallar = () => { const db = openDb({ path: DB, readOnly: true }); const k = db.prepare('SELECT kalla FROM har_privat_agare ORDER BY kalla').all().map((r) => r.kalla); db.close(); return k; };
  for (const flaggor of [[], ['--append', '--fullstandigt']]) {
    ok(kor('import-lagfarter', DB, juridisk, '--som', 'agare', ...flaggor));
    assert.deepEqual(kallar(), ['lagfart', 'taxering']);
  }
  ok(kor('import-lagfarter', DB, juridisk, '--som', 'agare', '--fullstandigt'));
  assert.deepEqual(kallar(), ['taxering']);
  ok(kor('import-taxering', DB, juridisk, '--enhet', 'tkr', '--fullstandigt'));
  assert.deepEqual(kallar(), []);
  const db = openDb({ path: DB }); markPrivata(db, [bet]); db.close();
  ok(kor('import-lagfarter', DB, juridisk, '--som', 'agare', '--fullstandigt'));
  assert.deepEqual(kallar(), ['okand']);
  const blandad = csv('blandad', 'Beteckning;Orgnr\n' + bet + ';5560000001\n' + bet + ';199001011234');
  ok(kor('import-lagfarter', DB, blandad, '--som', 'agare', '--fullstandigt'));
  assert.deepEqual(kallar(), ['lagfart', 'okand']);
});

test('äldre privatmarkering får okänd källa och kan inte hävas av ett nytt uttag', () => {
  const DB = dbfil('aldre');
  let db = new DatabaseSync(DB);
  db.exec("CREATE TABLE har_privat_agare (beteckning TEXT PRIMARY KEY); INSERT INTO har_privat_agare VALUES ('SOLNA PILEN 1')"); db.close();
  db = openDb({ path: DB });
  markPrivata(db, new Set(), 'lagfart', ['SOLNA PILEN 1']);
  assert.deepEqual({ ...db.prepare('SELECT * FROM har_privat_agare').get() }, { beteckning: 'SOLNA PILEN 1', kalla: 'okand' });
  db.close();
});

test('en misslyckad migrering lämnar det äldre privatskyddet intakt', () => {
  const DB = dbfil('migreringsfel');
  let db = new DatabaseSync(DB);
  db.exec("CREATE TABLE har_privat_agare (beteckning TEXT PRIMARY KEY); INSERT INTO har_privat_agare VALUES (NULL), ('SOLNA PILEN 1')"); db.close();
  assert.throws(() => openDb({ path: DB }), /NOT NULL/);
  db = new DatabaseSync(DB);
  assert.equal(db.prepare('SELECT count(*) AS n FROM har_privat_agare').get().n, 2);
  assert.deepEqual(db.prepare('PRAGMA table_info(har_privat_agare)').all().map((r) => r.name), ['beteckning']);
  db.close();
});
