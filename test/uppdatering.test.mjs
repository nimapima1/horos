import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ROOT, openDb } from '../lib/db.mjs';
import { uppdateraData } from '../scripts/uppdatera-data.mjs';
import { behallPlaner } from '../scripts/behall-planer.mjs';
import { markeraPlanHamtning, planTider } from '../lib/uppdateringsmeta.mjs';

const geometry = { type: 'Polygon', coordinates: [[[18, 59], [18.01, 59], [18.01, 59.01], [18, 59]]] };
const feature = { type: 'Feature', geometry, properties: { feature: { typ: 'detaljplan' },
  detaljplan: { objektidentitet: 'test', typ: 'detaljplan', status: 'laga kraft', namn: 'Ny plan' } } };
function publik(path, date = '2026-10-20T00:00:00.000Z') {
  const db = openDb({ path });
  db.exec("DROP TABLE har_privat_agare; CREATE TABLE meta (nyckel TEXT PRIMARY KEY, varde TEXT)");
  db.prepare('INSERT INTO meta VALUES (?, ?)').run('planer_hamtade', date);
  db.prepare("INSERT INTO plan (id, typ, kommun, geojson, kalla, status) VALUES ('ngp:0180:test', 'DP', '0180', ?, 'ngp', 'samråd')")
    .run(JSON.stringify(geometry));
  db.close();
}

test('daglig körning uppdaterar planer och nyheter men anger vilka källor som väntar', async () => {
  const dir = mkdtempSync(join(ROOT, 'data/_test/daglig-')), path = join(dir, 'arbete.sqlite');
  publik(path);
  const commands = [];
  const result = await uppdateraData(path, { env: { GEOTORGET_USER: 'test', GEOTORGET_PASS: 'test' },
    hamta: async (kommun) => { assert.equal(kommun, '0180'); return [feature]; },
    run: (script) => commands.push(script) });
  assert.equal(result.planer.status, 'uppdaterad');
  assert.equal(result.nyheter.status, 'uppdaterad');
  assert.equal(result.arbetsstallen.status, 'vantar');
  assert.equal(result.taxering.status, 'manuell');
  assert.deepEqual(commands, ['import-nyheter.mjs']);
  const db = new DatabaseSync(path, { readOnly: true });
  assert.equal(db.prepare('SELECT status FROM plan').get().status, 'laga kraft');
  assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE name='har_privat_agare'").get(), undefined);
  assert.deepEqual(JSON.parse(db.prepare("SELECT varde FROM meta WHERE nyckel='ngp_kommuner'").get().varde), ['0180']);
  db.close();
});

test('misslyckad hämtning och saknad inloggning lämnar originaldatabasen orörd', async () => {
  const dir = mkdtempSync(join(ROOT, 'data/_test/daglig-fel-'));
  const original = join(dir, 'public.sqlite'), work = join(dir, 'arbete.sqlite');
  publik(original); copyFileSync(original, work);
  await assert.rejects(uppdateraData(work, { env: {} }), /Geotorget/);
  copyFileSync(original, work);
  await assert.rejects(uppdateraData(work, { env: { GEOTORGET_USER: 'test', GEOTORGET_PASS: 'test' },
    hamta: async () => { throw new Error('Källan nere'); } }), /Källan nere/);
  const db = new DatabaseSync(original, { readOnly: true });
  assert.equal(db.prepare('SELECT status FROM plan').get().status, 'samråd');
  assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE name='har_privat_agare'").get(), undefined);
  db.close();
});

test('deploy behåller nyare planer från servern men ersätter inte en nyare lokal import', () => {
  const dir = mkdtempSync(join(ROOT, 'data/_test/daglig-deploy-'));
  const n = join(dir, 'ny.sqlite'), g = join(dir, 'gammal.sqlite');
  publik(n); publik(g, '2026-10-21T00:00:00.000Z');
  const ny = new DatabaseSync(n), gammal = new DatabaseSync(g);
  gammal.exec("UPDATE plan SET status='laga kraft'");
  assert.equal(behallPlaner(ny, gammal), true);
  assert.equal(ny.prepare('SELECT status FROM plan').get().status, 'laga kraft');
  ny.exec("UPDATE meta SET varde='2026-10-22T00:00:00.000Z' WHERE nyckel='planer_hamtade'");
  assert.equal(behallPlaner(ny, gammal), false);
  ny.close(); gammal.close();
});

test('deploy behåller andra kommuner när bara Stockholm har importerats på nytt', () => {
  const ny = openDb({ path: ':memory:' }), gammal = openDb({ path: ':memory:' });
  for (const [db, tid, kommun] of [[ny, '2026-10-22', '0180'], [gammal, '2026-10-21', '0181']]) {
    db.exec('CREATE TABLE meta(nyckel TEXT PRIMARY KEY,varde TEXT)');
    db.prepare('INSERT INTO meta VALUES (?,?)').run('planer_hamtade', tid);
    db.prepare("INSERT INTO plan(id,typ,kommun,geojson,kalla,status) VALUES(?,'DP',?,'{}','ngp','laga kraft')").run(`ngp:${kommun}:x`, kommun);
  }
  try {
    behallPlaner(ny, gammal);
    assert.deepEqual(ny.prepare('SELECT kommun FROM plan ORDER BY kommun').all().map((r) => r.kommun), ['0180', '0181']);
  } finally { ny.close(); gammal.close(); }
});

test('deploy stoppar äldre SCB-data före databasbytet', () => {
  const ny = openDb({ path: ':memory:' }), gammal = openDb({ path: ':memory:' });
  for (const db of [ny, gammal]) db.exec('CREATE TABLE meta(nyckel TEXT PRIMARY KEY,varde TEXT)');
  gammal.prepare('INSERT INTO meta VALUES (?,?)').run('scb_agarkontroll_hamtad', '2026-10-21');
  try {
    assert.throws(() => behallPlaner(ny, gammal), /SCB/);
    ny.prepare('INSERT INTO meta VALUES (?,?)').run('scb_agarkontroll_hamtad', '2026-10-22');
    assert.doesNotThrow(() => behallPlaner(ny, gammal));
    gammal.prepare('INSERT INTO meta VALUES (?,?)').run('scb_arbetsstallen_hamtad', '2026-10-21');
    assert.throws(() => behallPlaner(ny, gammal), /scb_arbetsstallen/);
    ny.prepare('INSERT INTO meta VALUES (?,?)').run('scb_arbetsstallen_hamtad', '2026-10-22');
    assert.doesNotThrow(() => behallPlaner(ny, gammal));
  } finally { ny.close(); gammal.close(); }
});

test('en kommunimport ändrar inte andra kommuners hämtningstid', () => {
  const db = openDb({ path: ':memory:' });
  try {
    markeraPlanHamtning(db, ['0180', '0181'], '2026-10-20');
    markeraPlanHamtning(db, ['0180'], '2026-10-22');
    assert.equal(planTider(db).get('0180'), '2026-10-22');
    assert.equal(planTider(db).get('0181'), '2026-10-20');
  } finally { db.close(); }
});

test('återställningen gör databasen läsbar före omstart även med umask 0077', () => {
  const script = readFileSync(join(ROOT, 'deploy/uppdatera.sh'), 'utf8');
  const recovery = script.slice(script.indexOf('  mv "$D/public.sqlite"'), script.indexOf('\nfi\n# Arkivet'));
  const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : 'bash';
  const result = spawnSync(bash, ['-c', `set -eu
    D=/dummy; arkiv=/dummy; stamp=test; gammal=/dummy/backup; mode=600
    mv() { :; }
    cp() { mode=600; }
    chmod() { mode="$1"; }
    systemctl() { [[ "$mode" == 644 ]] && echo readable; }
    ${recovery}`], { encoding: 'utf8' });
  assert.equal(result.stdout.includes('readable'), true, result.stderr || result.stdout);
});
