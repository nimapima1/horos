// Fastighetskarta – klient. MapLibre + JSON-API från server.mjs.
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
map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-left');

let selected = null;

// Satellitbild via vår egen server (se server.mjs). Byts mot Lantmäteriets ortofoto när det finns.
const SATELLIT = {
  tiles: [`${location.origin}${location.pathname.replace(/[^/]*$/, '')}tiles/satellit/{z}/{x}/{y}.jpg`],
  maxzoom: 15,
  attribution: 'Satellit: <a href="https://cloudless.eox.at" target="_blank" rel="noopener">EOxCloudless</a> by EOX IT Services GmbH (Contains modified Copernicus Sentinel data 2025)',
};

const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* privat läge */ } },
};

class BasemapToggle {
  onAdd(m) {
    this.map = m;
    this.el = document.createElement('div');
    this.el.className = 'maplibregl-ctrl maplibregl-ctrl-group basemap-toggle';
    this.btn = document.createElement('button');
    this.btn.type = 'button';
    this.btn.addEventListener('click', () => this.set(!this.on));
    this.el.append(this.btn);
    this.on = store.get('horos.satellit') === '1';
    this.render();
    return this.el;
  }
  onRemove() { this.el.remove(); }
  render() {
    this.btn.textContent = this.on ? 'Karta' : 'Satellit';
    this.btn.title = this.on ? 'Visa vanlig karta' : 'Visa satellitbild';
    this.btn.setAttribute('aria-pressed', String(this.on));
  }
  set(on) {
    this.on = on;
    store.set('horos.satellit', on ? '1' : '0');
    this.render();
    applyBasemap(on);
  }
}
const basemapToggle = new BasemapToggle();
map.addControl(basemapToggle, 'top-left');

function applyBasemap(satellit) {
  if (!map.getLayer('satellit')) return;
  map.setLayoutProperty('satellit', 'visibility', satellit ? 'visible' : 'none');
  // Fastigheterna blir lite genomskinligare så att bilden syns igenom.
  map.setPaintProperty('fastighet-fill', 'fill-opacity',
    ['case', ['boolean', ['feature-state', 'selected'], false], 0.85, satellit ? 0.45 : 0.6]);
}

map.on('load', () => {
  // Satellitlagret läggs under kartans etiketter så att gatunamn syns ovanpå bilden.
  const firstSymbol = map.getStyle().layers.find((l) => l.type === 'symbol')?.id;
  map.addSource('satellit', { type: 'raster', tiles: SATELLIT.tiles, tileSize: 256, maxzoom: SATELLIT.maxzoom, attribution: SATELLIT.attribution });
  map.addLayer({ id: 'satellit', type: 'raster', source: 'satellit', layout: { visibility: 'none' } }, firstSymbol);

  map.addSource('fastigheter', { type: 'geojson', data: EMPTY, promoteId: 'beteckning' });
  const fill = ['step', ['coalesce', ['get', 'varde_tkr'], -1],
    css('--v0'), 0, css('--v1'), 25000, css('--v2'), 100000, css('--v3'), 300000, css('--v4')];
  map.addLayer({
    id: 'fastighet-fill', type: 'fill', source: 'fastigheter',
    paint: {
      'fill-color': fill,
      'fill-opacity': ['case', ['boolean', ['feature-state', 'selected'], false], 0.9, 0.6],
    },
  });
  map.addLayer({
    id: 'fastighet-line', type: 'line', source: 'fastigheter',
    paint: {
      'line-color': ['case', ['boolean', ['feature-state', 'selected'], false], css('--text'), css('--surface')],
      'line-width': ['case', ['boolean', ['feature-state', 'selected'], false], 2.5, 0.6],
    },
  });

  map.on('click', 'fastighet-fill', (e) => openFastighet(e.features[0].properties.beteckning));
  map.on('mouseenter', 'fastighet-fill', () => (map.getCanvas().style.cursor = 'pointer'));
  map.on('mouseleave', 'fastighet-fill', () => (map.getCanvas().style.cursor = ''));
  map.on('moveend', loadVisible);
  applyBasemap(basemapToggle.on);
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

async function openFastighet(bet, { fly = false } = {}) {
  let f;
  try { f = await api(`/api/fastighet/${encodeURIComponent(bet)}`); }
  catch (e) { return showPanel(`<p class="empty">${esc(e.message)}</p>`); }
  select(f.beteckning);

  const agare = f.agare.length
    ? f.agare.map((a) => `<tr><td>${bolagLink(a.orgnr, a.namn, a.demo)}<div class="muted small">${fmtOrgnr(a.orgnr)}</div></td>
        <td>${esc(a.andel ?? '')}</td><td class="num">${esc(a.inskrivningsdag ?? '')}</td></tr>`).join('')
    : null;
  const tax = f.taxering.length
    ? f.taxering.map((t) => `<tr><td>${t.ar ?? ''}</td><td>${esc(t.typ ?? '')}</td><td class="num">${mkr(t.varde_tkr)}</td></tr>
        <tr><td></td><td class="muted small" colspan="2">Mark ${mkr(t.markvarde_tkr)} · Byggnad ${mkr(t.byggvarde_tkr)}${t.taxeringsenhet ? ` · Enhet ${esc(t.taxeringsenhet)}` : ''}</td></tr>`).join('')
    : null;
  const tx = f.transaktioner.length
    ? f.transaktioner.map((x) => `<tr><td class="num">${esc(x.inskrivningsdag ?? '')}</td>
        <td>${x.forvarvare_orgnr ? bolagLink(x.forvarvare_orgnr, x.forvarvare_namn) : '–'}<div class="muted small">${esc(x.art ?? '')}</div></td>
        <td class="num">${kr(x.kopeskilling_kr)}</td></tr>`).join('')
    : null;

  showPanel(`
    <h2>${esc(f.beteckning)}${demoTag(f.demo)}</h2>
    <div class="muted small">${esc(f.kommun ?? '')} · källa: ${f.kalla === 'demo' ? 'OpenStreetMap (exempel)' : 'Lantmäteriet'}</div>
    <dl style="margin-top:12px"><dt>Areal</dt><dd>${f.areal_m2 ? `${Math.round(f.areal_m2).toLocaleString('sv-SE')} m²` : '–'}</dd></dl>
    <h3>Lagfarna ägare</h3>
    ${agare ? `<table><tr><th>Ägare</th><th>Andel</th><th class="num">Sedan</th></tr>${agare}</table>` : '<p class="empty">Väntar på uppgifter från Lantmäteriet.</p>'}
    <h3>Taxering</h3>
    ${tax ? `<table><tr><th>År</th><th>Typ</th><th class="num">Värde</th></tr>${tax}</table>` : '<p class="empty">Väntar på uppgifter från Skatteverket.</p>'}
    <h3>Överlåtelser</h3>
    ${tx ? `<table><tr><th class="num">Datum</th><th>Förvärvare</th><th class="num">Köpeskilling</th></tr>${tx}</table>` : '<p class="empty">Inga registrerade överlåtelser.</p>'}
  `);
  if (fly) flyToBbox(f.beteckning);
}

async function openBolag(orgnr) {
  let b;
  try { b = await api(`/api/bolag/${orgnr}`); }
  catch (e) { return showPanel(`<p class="empty">${esc(e.message)}</p>`); }
  select(null);
  const sumTkr = b.fastigheter.reduce((s, f) => s + (f.varde_tkr ?? 0), 0);
  const rows = b.fastigheter.map((f) =>
    `<tr><td><a data-fastighet="${esc(f.beteckning)}" data-bbox="${[f.minx, f.miny, f.maxx, f.maxy].join(',')}">${esc(f.beteckning)}</a></td>
     <td class="num">${mkr(f.varde_tkr)}</td></tr>`).join('');
  showPanel(`
    <h2>${esc(b.namn)}${demoTag(b.demo)}</h2>
    <div class="muted small">${fmtOrgnr(b.orgnr)}${b.avregistrerad ? ` · <strong>avregistrerad ${esc(b.avregistrerad)}</strong>` : ''}</div>
    <dl style="margin-top:12px">
      <dt>Form</dt><dd>${esc(b.jurform ?? '–')}</dd>
      <dt>SNI</dt><dd>${esc(b.sni ?? '–')}</dd>
      <dt>Adress</dt><dd>${esc([b.adress, [b.postnr, b.postort].filter(Boolean).join(' ')].filter(Boolean).join(', ') || '–')}</dd>
      <dt>Registrerad</dt><dd>${esc(b.registrerad ?? '–')}</dd>
    </dl>
    ${b.verksamhet ? `<h3>Verksamhet</h3><p class="small">${esc(b.verksamhet)}</p>` : ''}
    <h3>Fastigheter (${b.fastigheter.length})${sumTkr ? ` · ${mkr(sumTkr)}` : ''}</h3>
    ${rows ? `<table><tr><th>Beteckning</th><th class="num">Taxeringsvärde</th></tr>${rows}</table>`
           : '<p class="empty">Inga kända fastigheter ännu. Ägaruppgifter läses in när Lantmäteriet har svarat.</p>'}
    <p class="muted small" style="margin-top:16px">Källa: Bolagsverket och SCB, värdefulla datamängder.</p>
  `);
}

function flyToBbox(bboxOrBet) {
  if (typeof bboxOrBet === 'string' && bboxOrBet.includes(',')) {
    const [a, b, c, d] = bboxOrBet.split(',').map(Number);
    map.fitBounds([[a, b], [c, d]], { padding: 120, maxZoom: 17 });
  }
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
    for (const f of r.fastigheter) items.push(`<li data-kind="f" data-id="${esc(f.beteckning)}" data-bbox="${[f.minx, f.miny, f.maxx, f.maxy].join(',')}">${esc(f.beteckning)}</li>`);
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
    <div class="muted small">Öppen karta över bolagsägda fastigheter i Stockholm</div>
    <p class="small">I antikens Athen ställdes gränsstenar, <em>horoi</em> (ὅροι), ut på tomter för att
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
    </dl>
    <h3>Integritet</h3>
    <p class="small">Horos visar bara fastigheter som ägs av juridiska personer. Uppgifter om privatpersoner
      samlas inte in och visas inte. Sidan använder inga kakor och sparar inte besökarnas IP-adresser.</p>
    <p class="small"><a href="metod.html">Metod, begränsningar och nedladdning av datan →</a></p>
  `);
}
$('#om').addEventListener('click', (e) => { e.preventDefault(); openOm(); });
if (location.hash === '#om') openOm();
addEventListener('hashchange', () => { if (location.hash === '#om') openOm(); });

// Status och demoflagga.
api('/api/status').then((s) => {
  $('#demo-banner').hidden = !s.demo;
  const n = (x) => x.toLocaleString('sv-SE');
  $('#counts').textContent =
    `${n(s.bolag)} juridiska personer · ${n(s.fastigheter)} fastigheter · ${n(s.taxeringar)} taxeringar · ${n(s.transaktioner)} överlåtelser`
    + (s.demo ? ` · ${n(s.demo)} exempelfastigheter` : '');
});
