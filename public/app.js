// Horos – klient. MapLibre + JSON-API från server.mjs.
const $ = (sel) => document.querySelector(sel);
const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fmtOrgnr = (d) => (d && d.length === 10 ? `${d.slice(0, 6)}-${d.slice(6)}` : d ?? '');
const kr = (n) => (n == null ? '–' : `${Math.round(n).toLocaleString('sv-SE')} kr`);
const mkr = (tkr) => (tkr == null ? '–' : `${(tkr / 1000).toLocaleString('sv-SE', { maximumFractionDigits: 1 })} Mkr`);
const api = (path) => fetch(path).then((r) => (r.ok ? r.json() : r.json().then((e) => Promise.reject(new Error(e.error)))));

// CSP-versionen av MapLibre laddar sin worker från en fil i stället för blob:.
maplibregl.setWorkerUrl('vendor/maplibre-gl-csp-worker.js');

const MIN_ZOOM = 14;
const EMPTY = { type: 'FeatureCollection', features: [] };

const map = new maplibregl.Map({
  container: 'map',
  style: matchMedia('(prefers-color-scheme: dark)').matches
    ? 'https://tiles.openfreemap.org/styles/dark'
    : 'https://tiles.openfreemap.org/styles/positron',
  center: [18.064, 59.334],
  zoom: 15,
  attributionControl: { compact: true },
});
map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');

let selected = null;

// Bildlager via vår egen server (se server.mjs), så att besökarnas IP-adresser stannar hos oss.
const BASE = `${location.origin}${location.pathname.replace(/[^/]*$/, '')}`;
const LM_ATTR = 'Flygfoto: <a href="https://www.lantmateriet.se" target="_blank" rel="noopener">© Lantmäteriet</a> (CC0)';
const IMAGERY = {
  satellit: {
    label: 'Satellit 2025 (10 m)',
    source: { tiles: [`${BASE}tiles/satellit/{z}/{x}/{y}.jpg`], maxzoom: 15,
      attribution: 'Satellit: <a href="https://cloudless.eox.at" target="_blank" rel="noopener">EOxCloudless</a> by EOX IT Services GmbH (Contains modified Copernicus Sentinel data 2025)' },
    paint: { 'raster-contrast': 0.08, 'raster-saturation': 0.15 },   // lite krispigare Sentinel-bild
  },
};
// Historiska flygfoton som täcker hela Stockholm (Lantmäteriet, CC0). Läggs till om servern har inloggning.
const HISTORISKA = { 2005: 'Flygfoto 2005 (färg, 0,5 m)', 1995: 'Flygfoto 1995 (sv/v)', 1975: 'Flygfoto 1975 (sv/v)', 1960: 'Flygfoto 1960-tal (sv/v)' };

const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* privat läge */ } },
};

class BasemapSelect {
  onAdd() {
    this.el = document.createElement('div');
    this.el.className = 'maplibregl-ctrl maplibregl-ctrl-group basemap-select';
    this.select = document.createElement('select');
    this.select.setAttribute('aria-label', 'Bakgrund');
    this.select.add(new Option('Karta', 'karta'));
    for (const [id, { label }] of Object.entries(IMAGERY)) this.select.add(new Option(label, id));
    this.select.addEventListener('change', () => this.set(this.select.value));
    this.el.append(this.select);
    this.value = store.get('horos.bakgrund') ?? 'karta';
    this.select.value = IMAGERY[this.value] ? this.value : 'karta';
    return this.el;
  }
  onRemove() { this.el.remove(); }
  addHistoriska(years) {
    for (const ar of Object.keys(HISTORISKA).sort((a, b) => b - a)) {
      if (!years.includes(Number(ar))) continue;
      IMAGERY[`h${ar}`] = {
        label: HISTORISKA[ar],
        source: { tiles: [`${BASE}tiles/historisk/${ar}/{z}/{x}/{y}.jpg`], minzoom: 10, maxzoom: 18,
          bounds: [17.5, 59.05, 18.75, 59.6], attribution: LM_ATTR },
      };
      this.select.add(new Option(HISTORISKA[ar], `h${ar}`));
    }
    if (IMAGERY[this.value] && this.select.value !== this.value) { this.select.value = this.value; applyBasemap(this.value); }
  }
  get imagery() { return this.select.value !== 'karta'; }
  set(value) {
    this.value = value;
    store.set('horos.bakgrund', value);
    applyBasemap(value);
  }
}
const basemap = new BasemapSelect();
map.addControl(basemap, 'top-right');

const SEL = ['boolean', ['feature-state', 'selected'], false];
const HOVER = ['boolean', ['feature-state', 'hover'], false];
const valueColor = () => ['step', ['coalesce', ['get', 'varde_tkr'], -1],
  css('--v0'), 0, css('--v1'), 25000, css('--v2'), 100000, css('--v3'), 300000, css('--v4')];

// På kartan fylls fastigheterna med färg. Över satellitbilden är de osynliga (men klickbara)
// tills man hovrar eller klickar, så att bilden går att läsa.
const fastighetPaint = (satellit) => (satellit
  ? {
    'fill-opacity': ['case', SEL, 0.3, HOVER, 0.18, 0],
    'line-color': ['case', SEL, '#FFFFFF', valueColor()],
    'line-width': ['case', SEL, 3.5, 2.5],
    'line-opacity': ['case', ['any', SEL, HOVER], 1, 0],
  }
  : {
    'fill-opacity': ['case', SEL, 0.85, HOVER, 0.75, 0.6],
    'line-color': ['case', ['any', SEL, HOVER], css('--text'), css('--surface-solid')],
    'line-width': ['case', SEL, 2.5, HOVER, 1.5, 0.6],
    'line-opacity': 1,
  });

// Visar valt bildlager (skapas första gången det väljs) under kartans etiketter.
function applyBasemap(value) {
  if (!map.getLayer('fastighet-fill')) return;
  const def = IMAGERY[value];
  if (def && !map.getLayer(value)) {
    const firstSymbol = map.getStyle().layers.find((l) => l.type === 'symbol')?.id;
    map.addSource(value, { type: 'raster', tileSize: 256, ...def.source });
    map.addLayer({ id: value, type: 'raster', source: value, paint: def.paint ?? {} }, firstSymbol);
  }
  for (const id of Object.keys(IMAGERY)) if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', id === value ? 'visible' : 'none');
  for (const [prop, v] of Object.entries(fastighetPaint(Boolean(def)))) {
    map.setPaintProperty(prop.startsWith('fill') ? 'fastighet-fill' : 'fastighet-line', prop, v);
  }
}

map.on('load', () => {
  map.addSource('fastigheter', { type: 'geojson', data: EMPTY, promoteId: 'beteckning' });
  const { 'fill-opacity': fillOp, ...linePaint } = fastighetPaint(basemap.imagery);
  map.addLayer({ id: 'fastighet-fill', type: 'fill', source: 'fastigheter', paint: { 'fill-color': valueColor(), 'fill-opacity': fillOp } });
  map.addLayer({ id: 'fastighet-line', type: 'line', source: 'fastigheter', paint: linePaint });

  map.on('click', 'fastighet-fill', (e) => openFastighet(e.features[0].properties.beteckning));
  let hovered = null;
  const setHover = (id) => {
    if (hovered) map.setFeatureState({ source: 'fastigheter', id: hovered }, { hover: false });
    hovered = id;
    if (hovered) map.setFeatureState({ source: 'fastigheter', id: hovered }, { hover: true });
  };
  map.on('mousemove', 'fastighet-fill', (e) => {
    map.getCanvas().style.cursor = 'pointer';
    if (e.features[0].id !== hovered) setHover(e.features[0].id);
  });
  map.on('mouseleave', 'fastighet-fill', () => { map.getCanvas().style.cursor = ''; setHover(null); });
  map.on('moveend', loadVisible);
  applyBasemap(basemap.select.value);
  loadVisible();
});

let loadSeq = 0;
async function loadVisible() {
  const tooFar = map.getZoom() < MIN_ZOOM;
  $('#zoom-hint').hidden = !tooFar;
  if (tooFar) return map.getSource('fastigheter').setData(EMPTY);
  const b = map.getBounds();
  const seq = ++loadSeq;
  const fc = await api(`/api/fastigheter?bbox=${[b.getWest(), b.getSouth(), b.getEast(), b.getNorth()].map((n) => n.toFixed(5)).join(',')}`);
  if (seq !== loadSeq) return;
  map.getSource('fastigheter').setData(fc);
  if (selected) map.setFeatureState({ source: 'fastigheter', id: selected }, { selected: true });
}

function select(beteckning) {
  if (selected) map.setFeatureState({ source: 'fastigheter', id: selected }, { selected: false });
  selected = beteckning;
  if (selected) map.setFeatureState({ source: 'fastigheter', id: selected }, { selected: true });
}

function showPanel(html) {
  $('#panel-body').innerHTML = html;
  $('#panel').hidden = false;
  $('#panel').scrollTop = 0;
}
$('#close').addEventListener('click', () => { $('#panel').hidden = true; select(null); });

const demoTag = (d) => (d ? '<span class="tag">exempel</span>' : '');
const bolagLink = (orgnr, namn, demo) =>
  `<a data-bolag="${esc(orgnr)}">${esc(namn ?? fmtOrgnr(orgnr))}</a>${demoTag(demo)}`;
const bboxAttr = (f) => `data-bbox="${[f.minx, f.miny, f.maxx, f.maxy].join(',')}"`;
// Tabell med rubrikrad, eller ett meddelande om raderna saknas.
const table = (head, rows, empty) => (rows.length
  ? `<table><tr>${head}</tr>${rows.join('')}</table>`
  : `<p class="empty">${empty}</p>`);
// Nyckeltal överst i panelen: [[etikett, värde], ...]
const stats = (items) => `<div class="stats">${items.map(([label, value]) =>
  `<div class="stat"><div class="stat-label">${label}</div><div class="stat-value">${value}</div></div>`).join('')}</div>`;

// Hämtar från API:t; vid fel visas felet i panelen och null returneras.
async function apiPanel(path) {
  try { return await api(path); }
  catch (e) { showPanel(`<p class="empty">${esc(e.message)}</p>`); return null; }
}

async function openFastighet(bet) {
  const f = await apiPanel(`/api/fastighet/${encodeURIComponent(bet)}`);
  if (!f) return;
  select(f.beteckning);
  // Senaste årets taxeringsvärde (summan av fastighetens taxeringsenheter) och senaste köp.
  const ar = f.taxering[0]?.ar;
  const varde = f.taxering.filter((t) => t.ar === ar).reduce((s, t) => s + (t.varde_tkr ?? 0), 0);
  const kop = f.transaktioner.find((x) => x.kopeskilling_kr != null);
  showPanel(`
    <h2>${esc(f.beteckning)}${demoTag(f.demo)}</h2>
    <div class="meta">${esc(f.kommun ?? '')} · källa: ${f.kalla === 'demo' ? 'OpenStreetMap (exempel)' : 'Lantmäteriet'}</div>
    ${stats([
      [`Taxeringsvärde${ar ? ` ${ar}` : ''}`, f.taxering.length ? mkr(varde) : '–'],
      ['Areal', f.areal_m2 ? `${Math.round(f.areal_m2).toLocaleString('sv-SE')} m²` : '–'],
      [`Senaste köp${kop?.inskrivningsdag ? ` ${kop.inskrivningsdag.slice(0, 4)}` : ''}`, kop ? mkr(kop.kopeskilling_kr / 1000) : '–'],
    ])}
    <h3>Lagfarna ägare</h3>
    ${table('<th>Ägare</th><th>Andel</th><th class="num">Sedan</th>', f.agare.map((a) =>
      `<tr><td>${bolagLink(a.orgnr, a.namn, a.demo)}<div class="muted small">${fmtOrgnr(a.orgnr)}</div></td>
        <td>${esc(a.andel ?? '')}</td><td class="num">${esc(a.inskrivningsdag ?? '')}</td></tr>`),
      'Väntar på uppgifter från Lantmäteriet.')}
    <h3>Taxering</h3>
    ${table('<th>År</th><th>Typ</th><th class="num">Värde</th>', f.taxering.map((t) =>
      `<tr><td>${t.ar ?? ''}</td><td>${esc(t.typ ?? '')}</td><td class="num">${mkr(t.varde_tkr)}</td></tr>
        <tr><td></td><td class="muted small" colspan="2">Mark ${mkr(t.markvarde_tkr)} · Byggnad ${mkr(t.byggvarde_tkr)}${t.taxeringsenhet ? ` · Enhet ${esc(t.taxeringsenhet)}` : ''}</td></tr>`),
      'Väntar på uppgifter från Skatteverket.')}
    <h3>Överlåtelser</h3>
    ${table('<th class="num">Datum</th><th>Förvärvare</th><th class="num">Köpeskilling</th>', f.transaktioner.map((x) =>
      `<tr><td class="num">${esc(x.inskrivningsdag ?? '')}</td>
        <td>${x.forvarvare_orgnr ? bolagLink(x.forvarvare_orgnr, x.forvarvare_namn) : '–'}<div class="muted small">${esc(x.art ?? '')}</div></td>
        <td class="num">${kr(x.kopeskilling_kr)}</td></tr>`),
      'Inga registrerade överlåtelser.')}
  `);
}

async function openBolag(orgnr) {
  const b = await apiPanel(`/api/bolag/${orgnr}`);
  if (!b) return;
  select(null);
  const sumTkr = b.fastigheter.reduce((s, f) => s + (f.varde_tkr ?? 0), 0);
  showPanel(`
    <h2>${esc(b.namn)}${demoTag(b.demo)}</h2>
    <div class="meta">${fmtOrgnr(b.orgnr)}${b.avregistrerad ? ` · <strong>avregistrerad ${esc(b.avregistrerad)}</strong>` : ''}</div>
    ${stats([['Fastigheter', b.fastigheter.length.toLocaleString('sv-SE')], ['Taxeringsvärde', sumTkr ? mkr(sumTkr) : '–']])}
    <dl>
      <dt>Form</dt><dd>${esc(b.jurform ?? '–')}</dd>
      <dt>SNI</dt><dd>${esc(b.sni ?? '–')}</dd>
      <dt>Adress</dt><dd>${esc([b.adress, [b.postnr, b.postort].filter(Boolean).join(' ')].filter(Boolean).join(', ') || '–')}</dd>
      <dt>Registrerad</dt><dd>${esc(b.registrerad ?? '–')}</dd>
    </dl>
    ${b.verksamhet ? `<h3>Verksamhet</h3><p class="small">${esc(b.verksamhet)}</p>` : ''}
    <h3>Fastigheter</h3>
    ${table('<th>Beteckning</th><th class="num">Taxeringsvärde</th>', b.fastigheter.map((f) =>
      `<tr><td><a data-fastighet="${esc(f.beteckning)}" ${bboxAttr(f)}>${esc(f.beteckning)}</a></td>
        <td class="num">${mkr(f.varde_tkr)}</td></tr>`),
      'Inga kända fastigheter ännu. Ägaruppgifter läses in när Lantmäteriet har svarat.')}
    <p class="muted small" style="margin-top:16px">Källa: Bolagsverket och SCB, värdefulla datamängder.</p>
  `);
}

function flyToBbox(bbox) {
  const [a, b, c, d] = bbox.split(',').map(Number);
  map.fitBounds([[a, b], [c, d]], { padding: 120, maxZoom: 17 });
}

// Länkar i panelen.
$('#panel').addEventListener('click', (e) => {
  const a = e.target.closest('a');
  if (!a) return;
  if (a.dataset.bolag) openBolag(a.dataset.bolag);
  if (a.dataset.fastighet) { flyToBbox(a.dataset.bbox); openFastighet(a.dataset.fastighet); }
});

// Sök.
let searchSeq = 0, searchTimer;
$('#q').addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(runSearch, 200);
});
$('#q').addEventListener('keydown', (e) => {
  if (e.key === 'Escape') $('#results').hidden = true;
  if (e.key === 'Enter') $('#results li[data-kind]')?.click();
});
document.addEventListener('click', (e) => { if (!e.target.closest('.search')) $('#results').hidden = true; });

async function runSearch() {
  const term = $('#q').value.trim();
  const seq = ++searchSeq;
  if (term.length < 2) return ($('#results').hidden = true);
  const r = await api(`/api/sok?q=${encodeURIComponent(term)}`);
  if (seq !== searchSeq) return;
  const items = [];
  if (r.fastigheter.length) {
    items.push('<li class="group">Fastigheter</li>');
    for (const f of r.fastigheter) items.push(`<li data-kind="f" data-id="${esc(f.beteckning)}" ${bboxAttr(f)}>${esc(f.beteckning)}</li>`);
  }
  if (r.bolag.length) {
    items.push('<li class="group">Bolag</li>');
    for (const b of r.bolag) items.push(`<li data-kind="b" data-id="${esc(b.orgnr)}">${esc(b.namn)}${demoTag(b.demo)} <span class="muted small">${fmtOrgnr(b.orgnr)}${b.postort ? ` · ${esc(b.postort)}` : ''}</span></li>`);
  }
  if (!items.length) items.push('<li class="group">Inga träffar</li>');
  $('#results').innerHTML = items.join('');
  $('#results').hidden = false;
}

$('#results').addEventListener('click', (e) => {
  const li = e.target.closest('li[data-kind]');
  if (!li) return;
  $('#results').hidden = true;
  if (li.dataset.kind === 'b') openBolag(li.dataset.id);
  else { flyToBbox(li.dataset.bbox); openFastighet(li.dataset.id); }
});

// Om Horos.
function openOm() {
  select(null);
  showPanel(`
    <h2>Horos</h2>
    <div class="meta">Öppen karta över bolagsägda fastigheter i Stockholm</div>
    <p>I antikens Athen ställdes gränsstenar, <em>horoi</em> (ὅροι), ut på tomter för att
      offentligt visa vem som hade anspråk på marken. Horos gör samma sak med dagens offentliga uppgifter:
      vilka bolag, föreningar och kommuner som äger fastigheterna, deras taxeringsvärden och vad de har köpts för.</p>
    <h3>Källor</h3>
    <dl>
      <dt>Bolag</dt><dd>Bolagsverket och SCB, värdefulla datamängder</dd>
      <dt>Gränser</dt><dd>Lantmäteriet, Fastighetsindelning</dd>
      <dt>Taxering</dt><dd>Skatteverket, allmänna handlingar</dd>
      <dt>Ägare, köp</dt><dd>Lantmäteriet, allmänna handlingar</dd>
      <dt>Karta</dt><dd>OpenFreeMap, © OpenStreetMap-bidragsgivare</dd>
      <dt>Satellit</dt><dd>EOxCloudless 2025 (Copernicus Sentinel-2)</dd>
      <dt>Flygfoton</dt><dd>Lantmäteriet, historiska ortofoton 1960–2005 (CC0)</dd>
    </dl>
    <h3>Integritet</h3>
    <p>Horos visar bara fastigheter som ägs av juridiska personer. Uppgifter om privatpersoner
      samlas inte in och visas inte. Sidan använder inga kakor och sparar inte besökarnas IP-adresser.</p>
    <p><a href="metod.html">Metod, begränsningar och nedladdning av datan →</a></p>
  `);
}
$('#om').addEventListener('click', (e) => { e.preventDefault(); openOm(); });
if (location.hash === '#om') openOm();
addEventListener('hashchange', () => { if (location.hash === '#om') openOm(); });

// Status och demoflagga.
api('/api/status').then((s) => {
  $('#demo-banner').hidden = !s.demo;
  const n = (x) => x.toLocaleString('sv-SE');
  $('#counts').textContent = s.demo
    ? `${n(s.demo)} exempelfastigheter · ${n(s.bolag)} bolag`
    : `${n(s.fastigheter)} fastigheter · ${n(s.bolag)} bolag · ${n(s.transaktioner)} överlåtelser`;
  basemap.addHistoriska(s.historiska ?? []);
});
