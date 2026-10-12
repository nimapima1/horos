// Kassaflödeskalkylen för scenarier (public/kalkyl.js, ett vanligt skript i webbläsaren).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import { ROOT } from '../lib/db.mjs';

const { berakna, beraknaPortfolj, nyckeltal, standardSkatt } = vm.runInNewContext(
  `${readFileSync(join(ROOT, 'public', 'kalkyl.js'), 'utf8')}\n({ berakna, beraknaPortfolj, nyckeltal, standardSkatt })`);
const scenario = (over = {}) => ({ v: 1, namn: 'Test', start: 2026, ar: 2, bet: ['T 1:1'],
  gemensamt: { hyresutv: 0, kostutv: 0, direktavk: 5 },
  antaganden: { Kontor: { hyra: 2000, vakans: 10, drift: 300, uh: 100 } }, egna: { 'T 1:1': { skatt: 0 } }, ...over });
const fastighet = { beteckning: 'T 1:1', varde_tkr: 50000, typ: 'Hyreshusenhet, lokaler', loa: { Kontor: 1000 } };
const nara = (a, b) => assert.ok(Math.abs(a - b) < 1e-6 * Math.max(1, Math.abs(b)), `${a} ≠ ${b}`);

test('utan tillväxt och med kalkylränta = direktavkastning blir värdet driftnetto / direktavkastning', () => {
  const k = berakna(scenario(), [fastighet]);
  assert.deepEqual([...k.ar], [2026, 2027, 2028]);   // listor från vm-kontexten jämförs som vanliga listor
  // 1 000 m² × 2 000 kr, 10 % vakans, drift och underhåll 400 kr/m²: driftnetto 1,4 Mkr varje år.
  assert.deepEqual([...k.total.dn], [1_400_000, 1_400_000, 1_400_000]);
  nara(k.varde, 28_000_000);
  nara(k.per[0].varde, 28_000_000);
  const t = nyckeltal(k);
  nara(t.direktavkastning, 0.05);
  nara(t.vakans, 0.1);
  nara(t.vakanstalighet, 0.8);   // 1,4 / 2,0 + 10 %
  nara(t.doutalighet, 3.5);      // 1,4 / 0,4
});

test('tillväxt, kalkylränta, nuvärde och restvärde räknas år för år', () => {
  const k = berakna(scenario({ gemensamt: { hyresutv: 2, kostutv: 2, direktavk: 5 } }), [fastighet]);
  nara(k.kalkylranta, 0.07);   // direktavkastning + hyresutveckling
  const dn = [0, 1, 2].map((i) => 1_400_000 * 1.02 ** i);
  dn.forEach((v, i) => nara(k.total.dn[i], v));
  nara(k.varde, dn[0] / 1.07 + dn[1] / 1.07 ** 2 + dn[2] / 0.05 / 1.07 ** 2);
});

test('egna ytor och belopp går före Horos uppskattning; utan direktavkastningskrav inget värde', () => {
  const s = scenario({ gemensamt: { hyresutv: 0, kostutv: 0 }, egna: { 'T 1:1': { yta: { Kontor: 500, Bostäder: 100 }, avgald: 10_000 } } });
  s.antaganden.Bostäder = { hyra: 1500 };
  const k = berakna(s, [fastighet]);
  assert.equal(k.yta, 600);
  assert.equal(k.total.hyra[0], 500 * 2000 + 100 * 1500);
  assert.equal(k.total.skatt[0], -500_000);   // 1 % av 50 Mkr, inget eget belopp
  assert.equal(k.total.avgald[0], -10_000);
  assert.equal(k.varde, null);
});

test('fastighetsskatt efter taxeringstyp', () => {
  assert.equal(standardSkatt({ varde_tkr: 10000, typ: 'Industrienhet' }), 50_000);
  assert.equal(standardSkatt({ varde_tkr: 10000, typ: 'Hyreshusenhet, bostäder' }), 30_000);
  assert.equal(standardSkatt({ varde_tkr: null, typ: null }), 0);
});

test('fastighetsskatt som text i en importerad fil ger inte NaN', () => {
  const k = berakna(scenario({ egna: { 'T 1:1': { skatt: 'abc' } } }), [fastighet]);
  assert.equal(k.total.skatt[0], 0);
  assert.equal(berakna(scenario({ egna: { 'T 1:1': { skatt: '1000' } } }), [fastighet]).total.skatt[0], -1000);
});

// #sd=-länkarna (public/scenario.js): scenariot ska komma tillbaka oförändrat, också med å, ä, ö.
test('scenario i länken: packa och packa upp', async () => {
  const { packa, packaUpp } = vm.runInNewContext(`${readFileSync(join(ROOT, 'public', 'scenario.js'), 'utf8')}\n({ packa, packaUpp })`,
    { CompressionStream, DecompressionStream, Response, Blob, btoa, atob, Uint8Array, JSON, String });
  const s = scenario({ namn: 'Fastigheter på Söder', bet: Array.from({ length: 500 }, (_, i) => `SÖDER ${i}:1`) });
  const lank = await packa(s);
  assert.match(lank, /^[\w-]+$/);   // bara tecken som får stå i en adress
  assert.deepEqual(JSON.parse(JSON.stringify(await packaUpp(lank))), s);
});

test('portfölj: delscenarier räknas med egna antaganden, huvudscenariots period och varje fastighet en gång', () => {
  const t2 = { ...fastighet, beteckning: 'T 1:2', varde_tkr: 20000 };
  const t3 = { ...fastighet, beteckning: 'T 1:3', varde_tkr: 30000, loa: { Kontor: 500 } };
  // Delen har T 1:1 (finns redan i huvudscenariot och räknas där) och T 1:2.
  const del = { namn: 'B', start: 2030, ar: 9, bet: ['T 1:1', 'T 1:2'], gemensamt: { direktavk: 5 },
    antaganden: { Kontor: { hyra: 1000 } }, egna: { 'T 1:2': { skatt: 0 } } };
  const p = beraknaPortfolj(scenario({ delar: [del] }), [fastighet, t2, t3]);
  assert.deepEqual([...p.delar].map((d) => [d.namn, d.antal, d.taxering_tkr]), [['Test', 1, 50000], ['B', 1, 20000]]);
  assert.deepEqual([...p.ar], [2026, 2027, 2028]);   // huvudscenariots period, inte delens
  assert.equal(p.total.dn[0], 1_400_000 + 1_000_000);   // T 1:1 med huvudets antaganden, T 1:2 med delens
  nara(p.varde, 28_000_000 + 20_000_000);
  assert.equal(p.yta, 2000);
  // En del utan direktavkastningskrav: inget totalvärde.
  assert.equal(beraknaPortfolj(scenario({ delar: [{ namn: 'C', bet: ['T 1:3'], gemensamt: {} }] }), [fastighet, t3]).varde, null);
  assert.equal(beraknaPortfolj(scenario(), [fastighet]).varde, berakna(scenario(), [fastighet]).varde);   // utan delar som förut
});
