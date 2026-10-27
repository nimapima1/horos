import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import { ROOT } from '../lib/db.mjs';

// Fastighetspanelens HTML för svaret f från /api/fastighet.
async function panel(f) {
  let html;
  const ctx = vm.createContext({ api: async () => f, statusP: Promise.resolve({ upplatelseformer: [], lokaltyper: [], foretag: false }),
    esc: String, kr: String, mkr: String, fmtOrgnr: String, rensaVy() {}, select() {}, scenarioMeny: () => '',
    googleLankar: () => '', mittpunkt: () => [18, 59], streetView: { visa() {} }, showPanel: (s) => html = s });
  vm.runInContext(readFileSync(join(ROOT, 'public', 'panel.js'), 'utf8'), ctx);
  await vm.runInContext('openFastighet("SOLNA PILEN 1")', ctx);
  return html;
}

test('fastighetspanelen visar ingen privat överlåtelse och tillskriver inte ett äldre bolag försäljningen', async () => {
  const f = { beteckning: 'SOLNA PILEN 1', kalla: 'lantmateriet', adresser: [], taxering: [], agare: [],
    planer: [], hyresgaster: [], anvandning: [], nyheter: [], grannar: [], narKop: [], transaktioner: [
      { inskrivningsdag: '2026-01-01', kopeskilling_kr: 333, forvarvare_orgnr: '5560000002', forvarvare_namn: 'Beta AB' },
      { privat: true },
      { inskrivningsdag: '2018-01-01', kopeskilling_kr: 111, forvarvare_orgnr: '5560000001', forvarvare_namn: 'Alfa AB' } ] };
  const html = await panel(f);
  const overlatelser = html.slice(html.indexOf('<h3>Överlåtelser</h3>'), html.indexOf('<h3>Köp i närheten</h3>'));
  assert.match(overlatelser, /Beta AB/); assert.match(overlatelser, /Alfa AB/);
  assert.doesNotMatch(overlatelser, /2020|222|från/);
});

test('taxeringsvärdet delas upp i mark och byggnad, summerat över årets taxeringsenheter', async () => {
  const tom = { beteckning: 'SOLNA PILEN 1', kalla: 'lantmateriet', adresser: [], agare: [], planer: [], hyresgaster: [],
    anvandning: [], nyheter: [], grannar: [], narKop: [], transaktioner: [] };
  const html = await panel({ ...tom, taxering: [
    { ar: 2025, varde_tkr: 1000, markvarde_tkr: 300, byggvarde_tkr: 700 },
    { ar: 2025, varde_tkr: 500, markvarde_tkr: 500, byggvarde_tkr: 0 },
    { ar: 2022, varde_tkr: 900, markvarde_tkr: 900, byggvarde_tkr: 0 } ] });
  assert.ok(html.includes('Taxeringsvärde 2025</div><div class="stat-value">1500</div><div class="fact-sub">Mark 800 · byggnad 700<'));
  // Utan uppdelning ingen underrad i rutan.
  assert.ok((await panel({ ...tom, taxering: [{ ar: 2025, varde_tkr: 1000 }] })).includes('<div class="stat-value">1000</div></div>'));
});
