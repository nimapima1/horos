// Bladet nedtill på mobilen (public/ark.js, ett vanligt skript i webbläsaren).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import { ROOT } from '../lib/db.mjs';

const { projicera, gummiband, narmastLage, fjaderSteg } = vm.runInNewContext(
  `${readFileSync(join(ROOT, 'public', 'ark.js'), 'utf8')}\n({ projicera, gummiband, narmastLage, fjaderSteg })`);

test('projicera: stilla blir kvar, ett svep fortsätter åt samma håll', () => {
  assert.equal(projicera(0), 0);
  assert.ok(Math.abs(projicera(1000) - 499) < 1);
  assert.equal(projicera(-1000), -projicera(1000));
});

test('gummiband: följer allt mindre och aldrig längre än storleken', () => {
  assert.equal(gummiband(0, 600), 0);
  assert.ok(gummiband(-100, 600) > -100 && gummiband(-100, 600) < 0);
  assert.ok(Math.abs(gummiband(-1e6, 600)) < 600);
});

test('narmastLage: ett långsamt släpp stannar, ett svep nedåt stänger', () => {
  const lagen = [0, 300, 820];   // uppfällt, normalt, stängt
  assert.equal(narmastLage(lagen, 340, 0), 300);
  assert.equal(narmastLage(lagen, 340, 1500), 820);
  assert.equal(narmastLage(lagen, 280, -900), 0);
});

test('fjaderSteg: kritiskt dämpad når målet utan att skjuta över, lägre dämpning studsar', () => {
  const kor = (dampning) => {
    let s = { x: 0, v: 0 }, max = 0;
    for (let i = 0; i < 120; i++) { s = fjaderSteg(s, 100, 1 / 60, dampning); max = Math.max(max, s.x); }
    return { s, max };
  };
  const kritisk = kor(1);
  assert.ok(Math.abs(kritisk.s.x - 100) < 0.5 && kritisk.max <= 100.01);
  assert.ok(kor(0.5).max > 105);
});
