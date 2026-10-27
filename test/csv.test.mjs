import { csvCell } from '../lib/csv.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readDbf, readXlsx, mapColumns } from '../lib/csv.mjs';
import { zip } from './zip.mjs';

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

test('CSV skyddar formelprefix i text, även efter blanksteg; tal och citering bevaras', () => {
  for (const v of ['=1+1', '+1', '-1', '@SUM(A1)', ' \t=1+1']) assert.equal(csvCell(v), "'" + v);
  assert.equal(csvCell(-1), '-1'); assert.equal(csvCell(0), '0'); assert.equal(csvCell(null), '');
  assert.equal(csvCell('=1;"x"'), '"\'=1;""x"""');
  assert.equal(csvCell('\r-1'), '"\'\r-1"');
  assert.equal(csvCell('rad\rslut'), '"rad\rslut"');
});

test('readXlsx: bladet enligt arbetsboken, delad och egen text, tomma celler på rätt kolumn, XML-tecken', () => {
  const xlsx = Buffer.from(zip([
    ['xl/workbook.xml', '<workbook><sheets><sheet name="Ark" sheetId="1" r:id="rId2"/></sheets></workbook>', false],
    ['xl/_rels/workbook.xml.rels', '<Relationships><Relationship Id="rId1" Target="worksheets/fel.xml"/><Relationship Target="worksheets/sheet2.xml" Id="rId2"/></Relationships>', true],
    ['xl/sharedStrings.xml', '<sst><si><t>LÄN</t></si><si><r><t>KÖP</t></r><r><t>MANNEN 1</t></r></si><si><t>A &amp; B</t></si></sst>', true],
    ['xl/worksheets/sheet2.xml', '<sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="C1" t="s"><v>2</v></c></row>'
      + '<row r="2"><c r="A2"><v>1</v></c><c r="B2" t="s"><v>1</v></c><c r="C2" t="inlineStr"><is><t>x&lt;y</t></is></c><c r="D2" s="1"/></row></sheetData>', true],
  ]));
  assert.deepEqual(readXlsx(xlsx), [['LÄN', '', 'A & B'], ['1', 'KÖPMANNEN 1', 'x<y', '']]);
  assert.throws(() => readXlsx(Buffer.alloc(100)), /inte en Excelfil/);
  // Synonymerna i ordning: värdet ska inte hamna på markvärdet, som står först och också innehåller "varde".
  assert.deepEqual(mapColumns(['MARKVÄRDE (tkr)', 'TAXERINGSVÄRDE  (tkr)'], { varde: ['taxeringsvarde', 'varde'] }), { varde: 1 });
});
