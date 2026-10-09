import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from '../lib/db.mjs';

const DIR = join(ROOT, 'data', '_test');
const GPKG = join(DIR, 'planer-test.gpkg');
const DB = join(DIR, 'planer-test.sqlite');

// GeoPackage-geometri: "GP", version 0, flaggor (little endian, ingen envelope), srs, WKB-polygon.
function gpPolygon(ring) {
  const b = Buffer.alloc(8 + 9 + 4 + ring.length * 16);
  b.write('GP', 0); b[2] = 0; b[3] = 1; b.writeInt32LE(3006, 4);
  b[8] = 1; b.writeUInt32LE(3, 9); b.writeUInt32LE(1, 13); b.writeUInt32LE(ring.length, 17);
  ring.forEach(([x, y], i) => { b.writeDoubleLE(x, 21 + i * 16); b.writeDoubleLE(y, 29 + i * 16); });
  return b;
}
const rect = (x, y, w, h) => [[x, y], [x + w, y], [x + w, y + h], [x, y + h], [x, y]];

test('import-planer läser plantyper ur en GeoPackage och hoppar över övriga bestämmelser', () => {
  mkdirSync(DIR, { recursive: true });
  for (const f of [GPKG, DB, `${DB}-wal`, `${DB}-shm`]) rmSync(f, { force: true });
  const g = new DatabaseSync(GPKG);
  g.exec(`CREATE TABLE gpkg_contents (table_name TEXT, data_type TEXT, srs_id INTEGER);
    CREATE TABLE gpkg_geometry_columns (table_name TEXT, column_name TEXT, geometry_type_name TEXT);
    CREATE TABLE plan_yta (fid INTEGER PRIMARY KEY, objektidentitet TEXT, objekttyp TEXT, aktbeteckning TEXT,
      plannamn TEXT, lagakraftdatum TEXT, kommunnamn TEXT, geom BLOB);
    INSERT INTO gpkg_contents VALUES ('plan_yta', 'features', 3006);
    INSERT INTO gpkg_geometry_columns VALUES ('plan_yta', 'geom', 'MULTIPOLYGON');`);
  const ins = g.prepare('INSERT INTO plan_yta VALUES (NULL, ?, ?, ?, ?, ?, ?, ?)');
  ins.run('a-1', 'DP', '0180K-P2015-01', 'Kv. Exempel', '2015-06-30', 'Stockholm', gpPolygon(rect(674000, 6580000, 200, 150)));
  ins.run('a-2', 'SPL', '0180K-1234', null, '1931-04-17 00:00:00', 'Stockholm', gpPolygon(rect(674100, 6580050, 300, 300)));
  ins.run('a-3', 'NATNR', 'NR-1', 'Ett naturreservat', null, 'Stockholm', gpPolygon(rect(670000, 6575000, 900, 900)));
  g.close();

  const run = (...a) => spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', join(ROOT, 'scripts', 'import-planer.mjs'), GPKG, ...a],
    { env: { ...process.env, FASTIGHETSKARTA_DB: DB }, encoding: 'utf8' });
  const r = run();
  assert.equal(r.status, 0, r.stderr);
  run();   // samma fil igen ersätter i stället för att dubblera

  const db = new DatabaseSync(DB, { readOnly: true });
  const rows = db.prepare('SELECT id, typ, planid, namn, datum, kommun, minx, miny FROM plan ORDER BY id').all();
  db.close();
  assert.deepEqual(rows.map((p) => [p.id, p.typ, p.planid, p.datum]),
    [['a-1', 'DP', '0180K-P2015-01', '2015-06-30'], ['a-2', 'SPL', '0180K-1234', '1931-04-17']]);
  assert.equal(rows[0].kommun, 'Stockholm');
  assert.ok(rows[0].minx > 17.9 && rows[0].minx < 18.2 && rows[0].miny > 59.2 && rows[0].miny < 59.4, 'koordinater i WGS84 nära Stockholm');
});
