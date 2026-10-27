// Inläsning av fastigheter från Excel och CSV (public/inlasning.js, ett vanligt skript i webbläsaren).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import { zip } from './zip.mjs';
import { ROOT } from '../lib/db.mjs';

const { lasCsv, hittaKolumner, packaUppZip } = vm.runInNewContext(
  `${readFileSync(join(ROOT, 'public', 'inlasning.js'), 'utf8')}\n({ lasCsv, hittaKolumner, packaUppZip })`,
  { DataView, TextDecoder, Response, Blob, DecompressionStream, Uint8Array, Error });
const vanlig = (x) => JSON.parse(JSON.stringify(x));   // listor från vm-kontexten jämförs som vanliga listor

test('CSV: semikolon och komma, citattecken och radslut som Excel skriver dem', () => {
  assert.deepEqual(vanlig(lasCsv('﻿Fastighetsbeteckning;Adress\r\nKUNGSBRON 1;"Gata 1; uppgång B"\r\n;"Säg ""hej"""\r\n')),
    [['Fastighetsbeteckning', 'Adress'], ['KUNGSBRON 1', 'Gata 1; uppgång B'], ['', 'Säg "hej"']]);
  assert.deepEqual(vanlig(lasCsv('Beteckning,Kommun\nA 1:1,Solna')), [['Beteckning', 'Kommun'], ['A 1:1', 'Solna']]);
});

test('kolumner: efter rubrik, annars den som ser ut som beteckningar; en beteckning är ingen rubrik', () => {
  assert.deepEqual(vanlig(hittaKolumner([['Mitt namn'], ['Nr', 'Gatuadress', 'Fastighet', 'Ort'], ['1', 'Gata 1', 'A 1:1', 'Solna']])),
    { start: 2, bet: 2, adress: 1, kommun: 3 });
  assert.deepEqual(vanlig(hittaKolumner([['x', 'FASTIGHETEN 1:2'], ['y', 'KUNGSBRON 1:3']])), { start: 0, bet: 1, adress: -1, kommun: -1 });
  assert.equal(hittaKolumner([['bara', 'text']]).bet, -1);
});

test('zip: packade och opackade filer kommer ut oförändrade; annat än zip ger ett begripligt fel', async () => {
  const filer = await packaUppZip(zip([['xl/worksheets/sheet1.xml', '<row>Å Ä Ö</row>'.repeat(50), true], ['mimetype', 'abc', false]]));
  assert.equal(new TextDecoder().decode(filer['xl/worksheets/sheet1.xml']), '<row>Å Ä Ö</row>'.repeat(50));
  assert.equal(new TextDecoder().decode(filer.mimetype), 'abc');
  await assert.rejects(packaUppZip(new Uint8Array(100)), /inte en Excelfil/);
});
