import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from '../lib/db.mjs';
import { lasShape } from '../lib/shp.mjs';
import { sweref99ToWgs84, sweref99tmToWgs84 } from '../lib/geo.mjs';

// En polygon med två ringar (yta + hål) och fälten namn (C) och nr (N), som QGIS skriver dem.
function skrivShape(sokvag) {
  const ringar = [[[0, 0], [0, 10], [10, 10], [10, 0], [0, 0]], [[2, 2], [4, 2], [4, 4], [2, 4], [2, 2]]];
  const pkt = ringar.flat();
  const innehall = Buffer.alloc(44 + 4 * ringar.length + 16 * pkt.length);
  innehall.writeInt32LE(5, 0);
  innehall.writeInt32LE(ringar.length, 36); innehall.writeInt32LE(pkt.length, 40);
  innehall.writeInt32LE(0, 44); innehall.writeInt32LE(5, 48);
  pkt.forEach(([x, y], i) => { innehall.writeDoubleLE(x, 52 + 16 * i); innehall.writeDoubleLE(y, 60 + 16 * i); });
  const post = Buffer.alloc(8); post.writeInt32BE(1, 0); post.writeInt32BE(innehall.length / 2, 4);
  writeFileSync(sokvag + '.shp', Buffer.concat([Buffer.alloc(100), post, innehall]));
  const falt = [['namn', 'C', 20], ['nr', 'N', 5]];
  const huvud = Buffer.alloc(32 + 32 * falt.length + 1);
  huvud.writeUInt32LE(1, 4); huvud.writeUInt16LE(huvud.length, 8); huvud.writeUInt16LE(1 + 25, 10);
  falt.forEach(([n, t, l], i) => { huvud.write(n, 32 + 32 * i, 'latin1'); huvud.write(t, 43 + 32 * i, 'latin1'); huvud[48 + 32 * i] = l; });
  huvud[huvud.length - 1] = 0x0d;
  // Fältlängderna är i byte, inte tecken (Ä är två byte i UTF-8).
  const namn = Buffer.alloc(20, ' '); Buffer.from('Ängen 1', 'utf8').copy(namn);
  writeFileSync(sokvag + '.dbf', Buffer.concat([huvud, Buffer.from(' '), namn, Buffer.from('   42')]));
  writeFileSync(sokvag + '.cpg', 'UTF-8');
  writeFileSync(sokvag + '.prj', 'PROJCS["SWEREF99_16_30",PARAMETER["False_Easting",150000.0],PARAMETER["Central_Meridian",16.5],PARAMETER["Scale_Factor",1.0]]');
}

test('shapefil: ringar, attribut och projektion läses', () => {
  const sokvag = join(mkdtempSync(join(ROOT, 'data/_test/shp-')), 'planer');
  skrivShape(sokvag);
  const { objekt, projektion } = lasShape(sokvag + '.shp');
  assert.deepEqual(projektion, { lon0: 16.5, k0: 1, FE: 150000 });
  assert.equal(objekt.length, 1);
  assert.deepEqual(objekt[0].p, { namn: 'Ängen 1', nr: '42' });
  assert.deepEqual(objekt[0].rings.map((r) => r.length), [5, 5]);
  assert.deepEqual(objekt[0].rings[1][1], [4, 2]);
});

test('shapefil: avklippt dbf-huvud ger fel, inte en oändlig loop', () => {
  const sokvag = join(mkdtempSync(join(ROOT, 'data/_test/shp-')), 'planer');
  skrivShape(sokvag);
  const huvud = Buffer.alloc(32); huvud.writeUInt16LE(97, 8);
  writeFileSync(sokvag + '.dbf', huvud);
  assert.throws(() => lasShape(sokvag + '.shp'), /saknar avslutning/);
});

test('SWEREF 99 lokal zon: medelmeridianen ger dess longitud, TM är oförändrad', () => {
  const [lon, lat] = sweref99ToWgs84(150000, 6300000, 16.5, 1, 150000);
  assert.ok(Math.abs(lon - 16.5) < 1e-9);
  assert.ok(lat > 56.8 && lat < 56.9);
  assert.deepEqual(sweref99ToWgs84(674032, 6580822), sweref99tmToWgs84(674032, 6580822));
});
