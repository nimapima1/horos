// Kommunnamn som de skrivs i filer (lib/kommuner.mjs), för inläsningen av fastigheter.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { kommunAv, kommunForst } from '../lib/kommuner.mjs';

test('kommunnamn i olika former blir kommunen; en postort är ingen kommun', () => {
  for (const t of ['Stockholm', 'STOCKHOLM', 'Stockholms kommun', 'Stockholms stad', ' stockholm ']) assert.equal(kommunAv(t), 'Stockholm', t);
  assert.equal(kommunAv('Borås kommun'), 'Borås');   // slutar på s utan att det är genitiv
  assert.equal(kommunAv('Upplands Väsby'), 'Upplands Väsby');
  assert.equal(kommunAv('Bromma'), null);
  assert.equal(kommunAv(''), null);
});

test('kommunen först i en beteckning; längsta namnet vinner', () => {
  assert.deepEqual(kommunForst('STOCKHOLM KUNGSBRON 1'), { kommun: 'Stockholm', resten: 'KUNGSBRON 1' });
  assert.deepEqual(kommunForst('UPPLANDS VÄSBY BRUNNBY 1:2'), { kommun: 'Upplands Väsby', resten: 'BRUNNBY 1:2' });
  assert.equal(kommunForst('KUNGSBRON 1'), null);
});

test('kommunkoder och kommunnamn med omgivande blanksteg normaliseras', () => {
  assert.equal(kommunAv('180'), 'Stockholm'); assert.equal(kommunAv('0184'), 'Solna');
  assert.equal(kommunAv(' Stockholms kommun  '), 'Stockholm'); assert.equal(kommunAv('9999'), null);
});
