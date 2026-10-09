import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, openDb } from '../lib/db.mjs';

test('openDb lägger till kolumnen tomtratt i en äldre databas', () => {
  const DB = join(ROOT, 'data', '_test', 'gammal.sqlite');
  mkdirSync(join(ROOT, 'data', '_test'), { recursive: true });
  for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) rmSync(f, { force: true });
  const gammal = new DatabaseSync(DB);
  gammal.exec(`CREATE TABLE agande (beteckning TEXT NOT NULL, orgnr TEXT NOT NULL, andel TEXT, inskrivningsdag TEXT,
    demo INTEGER NOT NULL DEFAULT 0); INSERT INTO agande (beteckning, orgnr) VALUES ('T 1:1', '5560000001');`);
  gammal.close();
  const db = openDb({ path: DB });
  const kolumner = db.prepare("SELECT name FROM pragma_table_info('agande')").all().map((r) => r.name);
  assert.deepEqual(kolumner, ['beteckning', 'orgnr', 'andel', 'inskrivningsdag', 'demo', 'tomtratt']);
  assert.equal(db.prepare('SELECT tomtratt FROM agande').get().tomtratt, null);   // befintliga rader: okänt
  db.close();
});
