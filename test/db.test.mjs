import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, openDb } from '../lib/db.mjs';

test('openDb lägger till nya kolumner i en äldre databas', () => {
  const DB = join(ROOT, 'data', '_test', 'gammal.sqlite');
  mkdirSync(join(ROOT, 'data', '_test'), { recursive: true });
  for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) rmSync(f, { force: true });
  const gammal = new DatabaseSync(DB);
  gammal.exec(`CREATE TABLE agande (beteckning TEXT NOT NULL, orgnr TEXT NOT NULL, andel TEXT, inskrivningsdag TEXT,
    demo INTEGER NOT NULL DEFAULT 0); INSERT INTO agande (beteckning, orgnr) VALUES ('T 1:1', '5560000001');
    CREATE TABLE arbetsstalle (cfar INTEGER PRIMARY KEY, orgnr TEXT NOT NULL, benamning TEXT, sni TEXT, avdelning TEXT,
      bransch TEXT, anstkl INTEGER, adress TEXT, postnr TEXT, ort TEXT, lon REAL, lat REAL, beteckning TEXT,
      demo INTEGER NOT NULL DEFAULT 0);`);
  gammal.close();
  const db = openDb({ path: DB });
  const kolumner = db.prepare("SELECT name FROM pragma_table_info('agande')").all().map((r) => r.name);
  assert.deepEqual(kolumner, ['beteckning', 'orgnr', 'andel', 'inskrivningsdag', 'demo', 'tomtratt']);
  assert.equal(db.prepare('SELECT tomtratt FROM agande').get().tomtratt, null);   // befintliga rader: okänt
  // Samma kolumnordning som en ny databas, så att build-public kan använda SELECT *.
  const ny = openDb({ path: join(ROOT, 'data', '_test', 'ny.sqlite') });
  const ordning = (d) => d.prepare("SELECT name FROM pragma_table_info('arbetsstalle')").all().map((r) => r.name);
  assert.deepEqual(ordning(db), ordning(ny));
  ny.close();
  db.close();
});
