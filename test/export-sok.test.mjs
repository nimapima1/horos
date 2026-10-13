import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import { ROOT, openDb, rebuildFastighetFts } from '../lib/db.mjs';

const server = readFileSync(join(ROOT, 'server.mjs'), 'utf8');

test('serverns CSV-fråga hämtar inga geometrier och räknar delägarnas enhet en gång', () => {
  const varde = server.match(/const SENASTE_VARDE = [\s\S]*?;/)?.[0];
  const exporten = server.match(/const exportSql = [\s\S]*?;/)?.[0];
  const sql = vm.runInNewContext(varde + '\n' + exporten + '\nexportSql(false)');
  const db = openDb({ path: ':memory:' });
  db.exec("INSERT INTO fastighet (beteckning, kommun, geojson, kalla) VALUES ('SOLNA PILEN 1', 'Solna', 'GEOMETRI SOM INTE SKA LÄSAS', 'lantmateriet');"
    + "INSERT INTO taxering (beteckning, taxeringsenhet, ar, varde_tkr) VALUES ('SOLNA PILEN 1', 'TE1', 2025, 10000), ('SOLNA PILEN 1', 'TE1', 2025, 10000)");
  db.exec("INSERT INTO transaktion (beteckning, inskrivningsdag, kopeskilling_kr, forvarvare_orgnr) VALUES ('SOLNA PILEN 1', '2018-01-01', 111, '5560000001'), ('SOLNA PILEN 1', '2020-01-01', 222, NULL)");
  const q = db.prepare(sql);
  assert.deepEqual(q.columns().map((c) => c.name), ['beteckning', 'kommun', 'areal_m2', 'agare_orgnr', 'agare_namn', 'taxeringsar',
    'taxeringsvarde_tkr', 'senaste_overlatelse', 'senaste_kopeskilling_kr']);
  const [r] = q.iterate();
  assert.equal(r.taxeringsvarde_tkr, 10000);
  assert.equal(r.senaste_overlatelse, '2018-01-01'); assert.equal(r.senaste_kopeskilling_kr, 111); db.close();
});

test('serverns faktiska fastighetssökning använder FTS-index utan tabellskanning eller temporär sortering', () => {
  const sql = server.match(/sokFastighet: db.prepare\(\x60([\s\S]*?)\x60\)/)?.[1];
  assert.ok(sql);
  const db = openDb({ path: ':memory:' });
  db.exec("INSERT INTO fastighet (beteckning, geojson, kalla) VALUES ('SOLNA PILEN 1', '{}', 'lantmateriet')");
  rebuildFastighetFts(db);
  assert.equal(db.prepare(sql).get('"pilen"* AND "1"*').beteckning, 'SOLNA PILEN 1');
  const plan = db.prepare('EXPLAIN QUERY PLAN ' + sql).all('"pilen"* AND "1"*').map((r) => r.detail).join('\n');
  assert.match(plan, /VIRTUAL TABLE INDEX/); assert.doesNotMatch(plan, /SCAN f\b|TEMP B-TREE/);
  db.close();
});

test('en äldre publik databas får ett tillfälligt sökindex utan att filen skrivs', () => {
  const fil = join(ROOT, 'data', '_test', 'aldre-sok.sqlite');
  for (const ext of ['', '-wal', '-shm']) rmSync(fil + ext, { force: true });
  let db = openDb({ path: fil });
  db.exec("INSERT INTO fastighet (beteckning, geojson, kalla) VALUES ('SOLNA PILEN 1', '{}', 'lantmateriet'); PRAGMA journal_mode = DELETE"); db.close();
  const fore = readFileSync(fil); db = openDb({ path: fil, readOnly: true });
  const kod = server.match(/else if \(!hasTable\('fastighet_fts'\)\) \{([\s\S]*?)\n\}/)?.[1];
  assert.ok(kod); vm.runInNewContext(kod, { db });
  const sql = server.match(/sokFastighet: db.prepare\(\x60([\s\S]*?)\x60\)/)[1];
  assert.equal(db.prepare(sql).get('"pilen"* AND "1"*').beteckning, 'SOLNA PILEN 1'); db.close();
  assert.deepEqual(readFileSync(fil), fore);
});
