// import-agarkontroll: SCB:s koder blir ord, enskilda firmor och okända bolag lämnas, torrkörning sparar inget.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, openDb } from '../lib/db.mjs';

const DIR = join(ROOT, 'data', '_test');
const DB = join(DIR, 'agarkontroll-test.sqlite');
const FIL = join(DIR, 'agarkontroll-test.json');
const kor = (...extra) => spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning',
  join(ROOT, 'scripts', 'import-agarkontroll.mjs'), '--fil', FIL, ...extra],
  { env: { ...process.env, FASTIGHETSKARTA_DB: DB }, encoding: 'utf8', timeout: 20_000 });
const varden = () => {
  const db = openDb({ path: DB, readOnly: true });
  const r = db.prepare('SELECT orgnr, agarkontroll FROM bolag ORDER BY orgnr').all().map((x) => [x.orgnr, x.agarkontroll]);
  db.close();
  return r;
};

test('import-agarkontroll översätter SCB:s koder och rör bara kända bolag', () => {
  mkdirSync(DIR, { recursive: true });
  for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) rmSync(f, { force: true });
  const db = openDb({ path: DB });
  db.exec(`INSERT INTO bolag (orgnr, namn) VALUES ('5560000001', 'Kommunbolaget AB'), ('5560000002', 'Privat AB'),
    ('5560000003', 'Okänd kod AB')`);
  db.close();
  writeFileSync(FIL, JSON.stringify([
    { jes: [{ peOrgNr: '165560000001', agKat: '20' }, { peOrgNr: '165560000002', agKat: '42' }] },
    { jes: [
      { peOrgNr: '165560000003', agKat: '99' },                // okänd kod: null
      { peOrgNr: '198001011234', agKat: '41' },                // enskild firma (personnummer)
      { peOrgNr: '165560000009', agKat: '10' },                // finns inte i bolag
    ] },
  ]));

  const dry = kor('--dry');
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /5 juridiska enheter lästa, 3 bolag uppdaterade, 1 finns inte i bolag, 1 enskilda firmor/);
  assert.deepEqual(varden(), [['5560000001', null], ['5560000002', null], ['5560000003', null]]);

  const r = kor();
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(varden(), [['5560000001', 'kommun'], ['5560000002', 'privat_koncern'], ['5560000003', null]]);
});
