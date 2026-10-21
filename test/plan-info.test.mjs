import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const esc = vm.runInNewContext(app.slice(app.indexOf('const esc ='), app.indexOf('const fmtOrgnr')) + '\nesc');
const { planInfo } = vm.runInNewContext(readFileSync(new URL('../public/panel.js', import.meta.url), 'utf8') + '\n({ planInfo })', {
  esc, URL, PLANTYP: { DP: 'Detaljplan' },
});

test('planrutan visar överlappande planer, status och datum samt skyddar extern text', () => {
  const html = planInfo([
    { namn: '<img src=x>', planid: 'DP-1', status: 'samråd', kalla: 'ngp' },
    { typ: 'DP', planid: 'DP-2', status: 'laga kraft', datum: '2025-01-01', kalla: 'ngp' },
  ]);
  assert.ok(html.includes('&lt;img src=x&gt;'));
  assert.ok(!html.includes('<img'));
  assert.ok(html.includes('DP-1') && html.includes('DP-2'));
  assert.ok(html.includes('samråd') && html.includes('Har inte fått laga kraft'));
  assert.ok(html.includes('Laga kraft: 2025-01-01'));
  assert.ok(html.includes('Nationella geodataplattformen'));
});

test('planrutan visar regler vid klickpunkten och markerar förslag', () => {
  const html = planInfo([{ namn: 'Exempel', status: 'samråd', bestammelser: [
    { etikett: 'B', text: 'Bostäder <test>', varde: null },
    { etikett: 'h1', text: 'Högsta nockhöjd', varde: { typ: 'max', tal: 8, enhet: 'meter' } },
  ] }]);
  assert.ok(html.includes('Föreslagna planbestämmelser här'));
  assert.ok(html.includes('Bostäder &lt;test&gt;'));
  assert.ok(html.includes('max 8 meter'));
  assert.ok(html.includes('Gäller klickpunkten'));
  assert.ok(planInfo([{ status: 'laga kraft', bestammelser: null }]).includes('inte hämtats'));
});

test('planrutan länkar till dokument och släpper inte igenom skriptadresser', () => {
  const html = planInfo([{ dokument: [
    { titel: 'Plankarta', url: 'https://kommun.example/plan.pdf' },
    { titel: 'Farlig', url: 'javascript:alert(1)' },
  ] }]);
  assert.ok(html.includes('href="https://kommun.example/plan.pdf"'));
  assert.ok(html.includes('rel="noopener noreferrer"'));
  assert.ok(!html.includes('javascript:'));
});


test('planrutan hämtar regler och dokument för vald plan utan kartlager', async () => {
  const calls = [];
  const rendered = [];
  class Popup {
    setLngLat(point) { this.point = point; return this; }
    setHTML(html) { rendered.push(html); return this; }
    addTo() { return this; }
    isOpen() { return true; }
  }
  const source = app.slice(app.indexOf('let planPopup;'), app.indexOf('map.addControl(planToggle'));
  const visaPlan = vm.runInNewContext(source + '\nvisaPlan', {
    maplibregl: { Popup }, map: {}, planInfo,
    api: async (url) => { calls.push(url); return { bestammelser: [{ text: 'Bostäder' }], dokument: [{ titel: 'Plankarta', url: 'https://example.org/plan.pdf' }] }; },
  });
  await visaPlan([{ id: 'plan-1', namn: 'Vald plan', fastighetsmitt: true }], { lng: 18, lat: 59 });
  assert.deepEqual(calls, ['/api/planbestammelser/plan-1?punkt=18,59']);
  assert.match(rendered.at(-1), /Bostäder/);
  assert.match(rendered.at(-1), /Plankarta/);
  assert.match(rendered.at(-1), /fastighetens kartmitt/);
});
