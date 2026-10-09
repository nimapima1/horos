import { test } from 'node:test';
import assert from 'node:assert/strict';
import { innerPoints, pointInGeom } from '../lib/geo.mjs';

const sq = (x0, y0, s) => ({ type: 'Polygon', coordinates: [[[x0, y0], [x0 + s, y0], [x0 + s, y0 + s], [x0, y0 + s], [x0, y0]]] });

test('innerPoints ligger inuti ytan och hittar delvis överlappande ytor', () => {
  const fastighet = sq(0, 0, 10);
  const pts = innerPoints(fastighet);
  assert.equal(pts.length, 36);
  assert.ok(pts.every((p) => pointInGeom(p, fastighet)));
  assert.ok(pts.some((p) => pointInGeom(p, sq(8, 8, 10))));      // överlappar hörnet
  assert.ok(!pts.some((p) => pointInGeom(p, sq(10, 0, 10))));    // delar bara en kant
});

test('innerPoints för en L-formad yta hamnar inte i urtaget', () => {
  const L = { type: 'Polygon', coordinates: [[[0, 0], [10, 0], [10, 2], [2, 2], [2, 10], [0, 10], [0, 0]]] };
  assert.ok(innerPoints(L).every((p) => pointInGeom(p, L)));
  assert.ok(!innerPoints(L).some((p) => pointInGeom(p, sq(3, 3, 7))));
});
