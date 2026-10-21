import { test } from 'node:test';
import assert from 'node:assert/strict';
import { avstandM, geomOverlap, innerPoints, pointInGeom } from '../lib/geo.mjs';

const sq = (x0, y0, s) => ({ type: 'Polygon', coordinates: [[[x0, y0], [x0 + s, y0], [x0 + s, y0 + s], [x0, y0 + s], [x0, y0]]] });

test('geomOverlap hittar små inneslutna planer och korsande ytor, men inte kantkontakt', () => {
  const a = sq(0, 0, 10), liten = sq(1, 1, 0.01);
  assert.equal(geomOverlap(a, liten), true);
  assert.equal(geomOverlap(liten, a), true);
  assert.equal(geomOverlap(a, a), true);
  assert.equal(geomOverlap(a, sq(8, 8, 10)), true);
  assert.equal(geomOverlap(a, sq(10, 0, 10)), false);
  assert.equal(geomOverlap(a, sq(10, 10, 10)), false);
  assert.equal(geomOverlap(a, sq(11, 0, 10)), false);
  const hole = { type: 'Polygon', coordinates: [...a.coordinates, ...sq(2, 2, 6).coordinates] };
  assert.equal(geomOverlap(hole, sq(3, 3, 1)), false);
  assert.equal(geomOverlap(hole, sq(1, 3, 2)), true);
  assert.equal(geomOverlap(hole, sq(2, 2, 6)), false);
  const multi = { type: 'MultiPolygon', coordinates: [sq(20, 20, 1).coordinates, liten.coordinates] };
  assert.equal(geomOverlap(a, multi), true);
  const horizontal = { type: 'Polygon', coordinates: [[[0, 4], [10, 4], [10, 6], [0, 6], [0, 4]]] };
  const vertical = { type: 'Polygon', coordinates: [[[4, 0], [6, 0], [6, 10], [4, 10], [4, 0]]] };
  assert.equal(geomOverlap(horizontal, vertical), true);
});

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

test('avstandM: 0 inuti, annars till närmaste kant i meter', () => {
  const ruta = sq(18, 59, 0.01);
  assert.equal(avstandM([18.005, 59.005], ruta), 0);
  assert.ok(Math.abs(avstandM([18.005, 59.02], ruta) - 0.01 * 111_320) < 1);   // norr om, rakt mot kanten
  const ost = avstandM([18.02, 59.005], ruta);                                 // öster om: längdgrader är kortare
  assert.ok(Math.abs(ost - 0.01 * 111_320 * Math.cos((59.005 * Math.PI) / 180)) < 1);
});
