import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lokaltyp, loaM2 } from '../lib/lokaltyp.mjs';

test('lokaltyp och uppskattad LOA från bransch och storleksklass', () => {
  assert.equal(lokaltyp({ avdelning: 'G', sni: '47710' }), 'Butik');               // detaljhandel
  assert.equal(lokaltyp({ avdelning: 'G', sni: '46900' }), 'Lager och logistik');  // partihandel
  assert.equal(lokaltyp({ avdelning: 'K', sni: '62100' }), 'Kontor');
  assert.equal(lokaltyp({ avdelning: null, sni: null }), 'Övrigt');
  assert.equal(loaM2({ avdelning: 'K', anstkl: 5 }), 34.5 * 20);                   // 20–49 anställda
  assert.equal(loaM2({ avdelning: 'H', anstkl: 1 }), 150);                         // 0 anställda räknas som 1
  assert.equal(loaM2({ avdelning: 'I', anstkl: null }), 30);                       // okänd storlek: 1 anställd
});
