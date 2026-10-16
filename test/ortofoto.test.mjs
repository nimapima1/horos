import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ovrNiva, valjBilder } from '../lib/ortofoto.mjs';

test('översikten är aldrig finare än 0,3 m och så grov som rutan tål', () => {
  assert.equal(ovrNiva(0.16), 0);          // 0,32 m
  assert.equal(ovrNiva(0.25), 0);          // 0,5 m
  assert.equal(ovrNiva(0.5), -1);          // originalet
  assert.equal(ovrNiva(0.16, 0.3), 0);     // zoom 18
  assert.equal(ovrNiva(0.16, 0.7), 1);     // 0,64 m
  assert.equal(ovrNiva(0.16, 4.9), 3);     // zoom 14: 2,56 m
  assert.equal(ovrNiva(0.16, 1000), 4);    // högst nivå 4
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
