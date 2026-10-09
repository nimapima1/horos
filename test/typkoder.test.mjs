import { test } from 'node:test';
import assert from 'node:assert/strict';
import { typText, okandKod } from '../lib/typkoder.mjs';

test('typkoder översätts med hänsyn till taxeringsåret', () => {
  assert.equal(typText('325', 2025), 'Hyreshusenhet, lokaler');
  assert.equal(typText(' 325 ', 2015), 'Hyreshusenhet, huvudsakligen lokaler');   // gammal text t.o.m. 2015
  assert.equal(typText('825', 2025), 'Specialenhet, skolbyggnad');
  assert.equal(typText('211', 2013), 'Småhusenhet, tomtmark till fritidsbostad');
  assert.equal(typText('320'), 'Hyreshusenhet, bostäder');                       // utan år: aktuell text
  assert.equal(typText('Hyreshusenhet, lokaler', 2025), 'Hyreshusenhet, lokaler');   // text lämnas
  assert.equal(typText('', 2025), null);
  assert.equal(typText('999', 2025), '999');                                     // okänd kod lämnas
  assert.equal(okandKod('999', 2025), true);
  assert.equal(okandKod('211', 2025), true);                                     // fanns bara t.o.m. 2014
  assert.equal(okandKod('211', 2014), false);
  assert.equal(okandKod('Hyreshusenhet, lokaler'), false);
});
