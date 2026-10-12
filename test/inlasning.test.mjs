// Inläsning av fastigheter från Excel och CSV (public/inlasning.js, ett vanligt skript i webbläsaren).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import { deflateRawSync } from 'node:zlib';
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

// En zip med en packad (deflate) och en opackad fil, som Excel skriver dem.
function zip(filer) {
  const lokala = [], centrala = [];
  let offset = 0;
  for (const [namn, text, packa] of filer) {
    const data = Buffer.from(text), ut = packa ? deflateRawSync(data) : data, n = Buffer.from(namn);
    const lokal = Buffer.alloc(30); lokal.writeUInt32LE(0x04034b50, 0); lokal.writeUInt16LE(packa ? 8 : 0, 8);
    lokal.writeUInt32LE(ut.length, 18); lokal.writeUInt32LE(data.length, 22); lokal.writeUInt16LE(n.length, 26);
    const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(packa ? 8 : 0, 10);
    central.writeUInt32LE(ut.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(n.length, 28);
    central.writeUInt32LE(offset, 42);
    lokala.push(lokal, n, ut); centrala.push(central, n);
    offset += 30 + n.length + ut.length;
  }
  const cd = Buffer.concat(centrala), slut = Buffer.alloc(22);
  slut.writeUInt32LE(0x06054b50, 0); slut.writeUInt16LE(filer.length, 10); slut.writeUInt32LE(cd.length, 12); slut.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...lokala, cd, slut]));
}

test('zip: packade och opackade filer kommer ut oförändrade; annat än zip ger ett begripligt fel', async () => {
  const filer = await packaUppZip(zip([['xl/worksheets/sheet1.xml', '<row>Å Ä Ö</row>'.repeat(50), true], ['mimetype', 'abc', false]]));
  assert.equal(new TextDecoder().decode(filer['xl/worksheets/sheet1.xml']), '<row>Å Ä Ö</row>'.repeat(50));
  assert.equal(new TextDecoder().decode(filer.mimetype), 'abc');
  await assert.rejects(packaUppZip(new Uint8Array(100)), /inte en Excelfil/);
});
