import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readDbf } from '../lib/csv.mjs';

// Minsta dBase III-fil: fälten ID (N, 4) och NAMN (C, 10), en giltig och en raderad post.
function dbf(rader) {
  const falt = [['ID', 'N', 4], ['NAMN', 'C', 10]];
  const huvud = 32 + 32 * falt.length + 1, postLangd = 1 + falt.reduce((s, f) => s + f[2], 0);
  const buf = Buffer.alloc(huvud + postLangd * rader.length, 0x20);
  buf.fill(0, 0, huvud);
  buf[0] = 3; buf.writeUInt32LE(rader.length, 4); buf.writeUInt16LE(huvud, 8); buf.writeUInt16LE(postLangd, 10);
  falt.forEach(([namn, typ, langd], i) => { const o = 32 + 32 * i; buf.write(namn, o, 'latin1'); buf.write(typ, o + 11, 'latin1'); buf[o + 16] = langd; });
  buf[huvud - 1] = 0x0d;
  rader.forEach(([raderad, id, namn], r) => {
    const o = huvud + r * postLangd;
    buf.write(raderad ? '*' : ' ', o, 'latin1');
    buf.write(String(id).padStart(4), o + 1, 'latin1');
    buf.write(namn, o + 5, 'utf8');
  });
  return buf;
}

test('readDbf läser fält som text (UTF-8) och hoppar över raderade poster', () => {
  assert.deepEqual(readDbf(dbf([[false, 12, 'Västerås'], [true, 13, 'Borta']])), [{ ID: '12', NAMN: 'Västerås' }]);
});
