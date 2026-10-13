import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import { deflateRawSync } from 'node:zlib';
import { ROOT } from '../lib/db.mjs';

const data = (namn, bet = ['PILEN 1']) => ({ v: 1, namn, start: 2026, ar: 5, bet,
  gemensamt: {}, antaganden: { Kontor: { hyra: 1000 } }, egna: {}, delar: [] });
const sc = (d, nyckel = d.namn) => ({ data: d, nyckel, lank: null, saknas: [], underlag: [], byggd: '2026-01-01' });
const vanlig = (v) => JSON.parse(JSON.stringify(v));
function miljo(api = async () => ({ fastigheter: [] })) {
  const sparat = new Map(), falt = { select() {} }, adresser = [];
  const ctx = vm.createContext({ structuredClone, Response, Blob, DecompressionStream, Uint8Array, atob, crypto: { randomUUID: () => 'ny' },
    statusP: Promise.resolve({ maxScenario: 1000, kortlankar: true }), api,
    store: { get: (k) => sparat.get(k), set: (k, v) => { sparat.set(k, v); return true; } },
    $: (s) => s === '#panel .scenario' ? null : falt,
    map: { getSource: () => null }, history: { replaceState: (_a, _b, u) => adresser.push(u) },
    location: { origin: 'https://horos.se', pathname: '/', search: '' },
    navigator: { clipboard: { writeText: async () => {} } }, esc: String, showPanel() {} });
  vm.runInContext(readFileSync(join(ROOT, 'public', 'kalkyl.js'), 'utf8'), ctx);
  vm.runInContext(readFileSync(join(ROOT, 'public', 'scenario.js'), 'utf8'), ctx, {
    filename: join(ROOT, 'public', 'scenario.js'), importModuleDynamically: vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER });
  vm.runInContext('visaScenario = async () => {}; uppdateraResultat = () => {};', ctx);
  const f = vm.runInContext('({ sparaScenario, gorHuvud, scenarioKlick, oppnaScenarioLank, oppnaPost, '
    + 'sparaLokalt, scenarioCsv, rakna: () => beraknaPortfolj(scenario.data, scenario.underlag), set: (s) => scenario = s, get: () => scenario })', ctx);
  return { ...f, sparat, falt, adresser };
}
const vanta = () => { let resolve; const p = new Promise((r) => resolve = r); return { p, resolve }; };

test('sent sparsvar får inte skriva över ett annat scenario eller dess lokala post', async () => {
  const svar = vanta(), startat = vanta();
  const m = miljo(() => { startat.resolve(); return svar.p; });
  const a = sc(data('A')), b = sc(data('B'));
  m.set(a); m.sparaLokalt();
  const jobb = m.sparaScenario({}); await startat.p;
  m.set(b); m.sparaLokalt();
  svar.resolve({ id: 'sparat-a' }); await jobb;
  assert.equal(m.get(), b); assert.equal(b.data.namn, 'B'); assert.equal(b.lank, null);
  assert.equal(JSON.parse(m.sparat.get('horos.scenarion')).find((x) => x.nyckel === 'B').data.namn, 'B');
  assert.deepEqual(m.adresser, []);
});

test('sparning ändrar inte antaganden som redigerats medan svaret väntar', async () => {
  const svar = vanta(), startat = vanta(); let skickat;
  const m = miljo((_url, d) => { skickat = d; startat.resolve(); return svar.p; });
  const a = sc(data('A')); m.set(a);
  const jobb = m.sparaScenario({}); await startat.p;
  a.data.antaganden.Kontor.hyra = 2000;
  assert.equal(skickat.antaganden.Kontor.hyra, 1000);
  svar.resolve({ id: 'a' }); await jobb;
  assert.equal(a.data.antaganden.Kontor.hyra, 2000); assert.equal(a.lank, null);
});

test('sparning av det öppna oförändrade scenariot sparar länken lokalt', async () => {
  const m = miljo(async () => ({ id: 'a' })), a = sc(data('A')); m.set(a);
  await m.sparaScenario({});
  assert.equal(a.lank, 'https://horos.se/#s=a');
  assert.equal(JSON.parse(m.sparat.get('horos.scenarion'))[0].lank, a.lank);
});

test('misslyckat byte av huvudscenario behåller den gamla sammanläggningen lokalt och i minnet', async () => {
  const m = miljo(async () => { throw Error('nätfel'); }), d = data('A'), b = data('B');
  d.delar = [{ ...b, nyckel: 'B' }]; const a = sc(d); m.set(a); m.sparaLokalt();
  const poster = JSON.parse(m.sparat.get('horos.scenarion'));
  m.sparat.set('horos.scenarion', JSON.stringify([...poster, { nyckel: 'B', data: b }]));
  const fore = m.sparat.get('horos.scenarion'), el = { dataset: { i: '0' }, checked: true };
  await m.gorHuvud(el);
  assert.equal(m.get(), a); assert.equal(d.delar.length, 1);
  assert.equal(m.sparat.get('horos.scenarion'), fore); assert.equal(el.checked, false);
});

test('lyckat byte av huvudscenario flyttar gruppen efter hämtningen', async () => {
  let anrop = 0;
  const m = miljo(async () => { anrop++; return { fastigheter: [] }; }), d = data('A'), b = data('B');
  d.delar = [{ ...b, nyckel: 'B' }]; m.set(sc(d)); m.sparaLokalt();
  const poster = JSON.parse(m.sparat.get('horos.scenarion'));
  m.sparat.set('horos.scenarion', JSON.stringify([...poster, { nyckel: 'B', data: b }]));
  await m.gorHuvud({ dataset: { i: '0' } });
  assert.equal(anrop, 1); assert.equal(m.get().nyckel, 'B');
  assert.deepEqual(vanlig(m.get().data.delar.map((x) => x.namn)), ['A']);
  assert.equal(JSON.parse(m.sparat.get('horos.scenarion')).find((x) => x.nyckel === 'A').data.delar.length, 0);
});

test('borttagning från huvudscenario behåller underlaget när en del använder fastigheten', async () => {
  const m = miljo(), d = data('A'); d.delar = [{ ...data('B'), nyckel: 'B' }];
  const a = sc(d); a.underlag = [{ beteckning: 'PILEN 1', loa: { Kontor: 100 } }]; m.set(a);
  await m.scenarioKlick({ dataset: { sc: 'ta-bort', bet: 'PILEN 1' } });
  assert.deepEqual(vanlig(d.bet), []); assert.equal(a.underlag[0].loa.Kontor, 100); assert.equal(m.rakna().yta, 100);
  d.delar = [];
  await m.scenarioKlick({ dataset: { sc: 'ta-bort', bet: 'PILEN 1' } });
  assert.equal(a.underlag.length, 0);
});

test('delad länk använder sparad delkopia; Mina scenarion uppdaterar den', async () => {
  const d = data('A'), del = data('B'); d.delar = [{ ...del, nyckel: 'B' }];
  const lokal = data('B'); lokal.antaganden.Kontor.hyra = 2000;
  const m = miljo(async (url) => url.startsWith('/api/scenario/') ? structuredClone(d) : { fastigheter: [] });
  m.sparat.set('horos.scenarion', JSON.stringify([{ nyckel: 'B', data: lokal }]));
  await m.oppnaScenarioLank('#s=a');
  assert.equal(m.get().data.delar[0].antaganden.Kontor.hyra, 1000);
  await m.oppnaPost({ nyckel: 'A', data: d });
  assert.equal(m.get().data.delar[0].antaganden.Kontor.hyra, 2000);
  await m.oppnaScenarioLank('#s=a');
  assert.equal(m.get().data.delar[0].antaganden.Kontor.hyra, 1000);
});

test('komprimerad delad länk behåller också delkopians antaganden', async () => {
  const d = data('A'); d.delar = [{ ...data('B'), nyckel: 'B' }];
  const lokal = data('B'); lokal.antaganden.Kontor.hyra = 2000;
  const m = miljo(); m.sparat.set('horos.scenarion', JSON.stringify([{ nyckel: 'B', data: lokal }]));
  await m.oppnaScenarioLank('#sd=' + deflateRawSync(JSON.stringify(d)).toString('base64url'));
  assert.equal(m.get().data.delar[0].antaganden.Kontor.hyra, 1000);
});

test('scenario-CSV använder samma textskydd och svenska decimalkomman', async () => {
  const m = miljo(), d = data('=1+1'); d.gemensamt.hyresutv = -2.5; m.set(sc(d));
  const csv = await m.scenarioCsv({ lokaltyper: [] });
  assert.ok(csv.startsWith("﻿Scenario;'=1+1\r\n"));
  assert.ok(csv.includes('Hyresutveckling, %;-2,5'));
});
