import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { ROOT } from '../lib/db.mjs';
import { valjBilder } from '../lib/ortofoto.mjs';

test('översikten är aldrig finare än 0,3 m (lib/ortofoto.py --test)', (t) => {
  const r = spawnSync(process.env.ORTOFOTO_PYTHON ?? 'python3', [join(ROOT, 'lib', 'ortofoto.py'), '--test'], { encoding: 'utf8' });
  if (r.error || (r.status !== 0 && !/AssertionError/.test(r.stderr))) return t.skip('python3 saknas');
  assert.equal(r.status, 0, r.stderr);
});

test('nyaste bilden som täcker rutan, och nyare ovanpå äldre', () => {
  const ruta = (x0, x1, datum, namn) => ({ namn, datum,
    geometri: JSON.stringify({ type: 'Polygon', coordinates: [[[x0, 0], [x1, 0], [x1, 1], [x0, 1], [x0, 0]]] }) });
  const horn = [[0.2, 0.2], [0.8, 0.2], [0.8, 0.8], [0.2, 0.8]];
  const gammal = ruta(0, 1, '2019-06-01', 'gammal'), ny = ruta(0, 1, '2025-05-01', 'ny'), halv = ruta(0, 0.5, '2026-05-01', 'halv');
  assert.deepEqual(valjBilder([gammal, ny], horn).map((b) => b.namn), ['ny']);
  assert.deepEqual(valjBilder([gammal, halv, ny], horn).map((b) => b.namn), ['ny', 'halv']);
  assert.deepEqual(valjBilder([halv], horn).map((b) => b.namn), ['halv']);
});
