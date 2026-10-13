import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import { ROOT } from '../lib/db.mjs';

test('fastighetspanelen visar ingen privat överlåtelse och tillskriver inte ett äldre bolag försäljningen', async () => {
  const f = { beteckning: 'SOLNA PILEN 1', kalla: 'lantmateriet', adresser: [], taxering: [], agare: [],
    planer: [], hyresgaster: [], anvandning: [], nyheter: [], grannar: [], narKop: [], transaktioner: [
      { inskrivningsdag: '2026-01-01', kopeskilling_kr: 333, forvarvare_orgnr: '5560000002', forvarvare_namn: 'Beta AB' },
      { privat: true },
      { inskrivningsdag: '2018-01-01', kopeskilling_kr: 111, forvarvare_orgnr: '5560000001', forvarvare_namn: 'Alfa AB' } ] };
  let html;
  const ctx = vm.createContext({ api: async () => f, statusP: Promise.resolve({ upplatelseformer: [], lokaltyper: [], foretag: false }),
    esc: String, kr: String, mkr: String, fmtOrgnr: String, rensaVy() {}, select() {}, scenarioMeny: () => '',
    googleLankar: () => '', mittpunkt: () => [18, 59], streetView: { visa() {} }, showPanel: (s) => html = s });
  vm.runInContext(readFileSync(join(ROOT, 'public', 'panel.js'), 'utf8'), ctx);
  await vm.runInContext('openFastighet("SOLNA PILEN 1")', ctx);
  const overlatelser = html.slice(html.indexOf('<h3>Överlåtelser</h3>'), html.indexOf('<h3>Köp i närheten</h3>'));
  assert.match(overlatelser, /Beta AB/); assert.match(overlatelser, /Alfa AB/);
  assert.doesNotMatch(overlatelser, /2020|222|från/);
});
