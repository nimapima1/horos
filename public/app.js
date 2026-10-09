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

// Plantyperna i Lantmäteriets Markreglerande bestämmelse.
const PLANTYP = {
  DP: 'Detaljplan', ÄDP: 'Ändring av detaljplan', SPL: 'Stadsplan', BPL: 'Byggnadsplan',
  OB: 'Områdesbestämmelser', ÄOB: 'Ändring av områdesbestämmelser', FP: 'Fastighetsplan',
  TI: 'Tomtindelning', APL: 'Avstyckningsplan', GPL: 'Generalplan',
};

// Knapp som slår av och på planlagret (detaljplaner m.m.).
class PlanToggle {
  onAdd() {
    this.el = document.createElement('div');
    this.el.className = 'maplibregl-ctrl maplibregl-ctrl-group plan-toggle';
    this.button = document.createElement('button');
    this.button.type = 'button';
    this.button.textContent = 'Detaljplaner';
    this.on = store.get('horos.planer') === '1';
    this.button.setAttribute('aria-pressed', String(this.on));
    this.button.addEventListener('click', () => {
      this.on = !this.on;
      this.button.setAttribute('aria-pressed', String(this.on));
      store.set('horos.planer', this.on ? '1' : '0');
      if (!map.getLayer('plan-line')) return;   // kartan laddas fortfarande; lagret skapas med rätt läge
      map.setLayoutProperty('plan-line', 'visibility', this.on ? 'visible' : 'none');
      loadVisible();
    });
    this.el.append(this.button);
    return this.el;
  }
  onRemove() { this.el.remove(); }
}
const planToggle = new PlanToggle();
map.addControl(planToggle, 'top-right');

const SEL = ['boolean', ['feature-state', 'selected'], false];
const HOVER = ['boolean', ['feature-state', 'hover'], false];

// Kategorier för kartfärgningen. Taxeringstyp och juridisk form finns som text i databasen.
// shortcut: typen tolkas på ord ("bostäder", "lokaler"); kommer Skatteverkets data som
// sifferkoder behöver de en egen tabell här.
const anvKat = (typ) => {
  const t = (typ ?? '').toLowerCase();
  if (!t) return 'Saknas';
  if (t.includes('bostäder och lokaler')) return 'Bostäder och lokaler';
  if (t.includes('bostad') || t.includes('bostäder')) return 'Bostäder';
  if (t.includes('lokal')) return 'Lokaler';
  if (t.includes('industri')) return 'Industri';
  if (t.includes('special')) return 'Special';
  return 'Övrigt';
};
const agarKat = (jurform) => {
  const j = (jurform ?? '').toLowerCase();
  if (!j) return 'Saknas';
  if (/aktiebolag|europabolag/.test(j)) return 'Aktiebolag';
  if (/bostadsrätt|bostadsförening|hyresrätt/.test(j)) return 'Bostadsrättsförening';
  if (/kommun|region|statlig|offentlig/.test(j)) return 'Kommun, region, stat';
  if (/handelsbolag|kommanditbolag/.test(j)) return 'Handels- och kommanditbolag';
  if (/stiftelse|förening|trossamfund/.test(j)) return 'Stiftelse, förening';
  return 'Övrigt';
};
const ANV_KAT = ['Bostäder', 'Lokaler', 'Bostäder och lokaler', 'Industri', 'Special', 'Övrigt'];
const AGAR_KAT = ['Aktiebolag', 'Bostadsrättsförening', 'Kommun, region, stat', 'Handels- och kommanditbolag', 'Stiftelse, förening', 'Övrigt'];
const KAT_FARG = ['--c1', '--c2', '--c3', '--c4', '--c5', '--c6'];
const thisYear = new Date().getFullYear();

// Färgläge: [uttryck för fill-color, teckenförklaring [[färgvariabel, text], ...]].
const COLOR_BY = {
  varde: () => [['step', ['coalesce', ['get', 'varde_tkr'], -1],
    css('--v0'), 0, css('--v1'), 25000, css('--v2'), 100000, css('--v3'), 300000, css('--v4')],
  [['--v1', '< 25 Mkr'], ['--v2', '25–100'], ['--v3', '100–300'], ['--v4', '> 300'], ['--v0', 'Saknas']]],
  anv: () => kategoriFarg('anv_kat', ANV_KAT),
  agartyp: () => kategoriFarg('agar_kat', AGAR_KAT),
  kopar: () => [['step', ['coalesce', ['get', 'kop_ar'], -1],
    css('--v0'), 0, css('--v1'), thisYear - 9, css('--v2'), thisYear - 4, css('--v3'), thisYear - 1, css('--v4')],
  [['--v1', `Före ${thisYear - 9}`], ['--v2', `${thisYear - 9}–${thisYear - 5}`], ['--v3', `${thisYear - 4}–${thisYear - 2}`],
    ['--v4', `${thisYear - 1}–${thisYear}`], ['--v0', 'Inget köp']]],
};
function kategoriFarg(prop, kat) {
  return [['match', ['get', prop], ...kat.flatMap((k, i) => [k, css(KAT_FARG[i])]), css('--v0')],
    [...kat.map((k, i) => [KAT_FARG[i], k]), ['--v0', 'Saknas']]];
}
const colorBy = $('#color-by');
colorBy.value = COLOR_BY[store.get('horos.farg')] ? store.get('horos.farg') : 'varde';
const valueColor = () => COLOR_BY[colorBy.value]()[0];
function renderLegend() {
  $('#legend-scale').innerHTML = COLOR_BY[colorBy.value]()[1]
    .map(([v, text]) => `<span><i style="background:var(${v})"></i>${esc(text)}</span>`).join('');
}
renderLegend();
colorBy.addEventListener('change', () => {
  store.set('horos.farg', colorBy.value);
  renderLegend();
  applyBasemap(basemap.select.value);   // sätter fyll- och linjefärg på nytt
  map.setPaintProperty('fastighet-fill', 'fill-color', valueColor());
});

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
  // Plangränser ovanpå fastigheterna, streckade så att de inte förväxlas med fastighetsgränser.
  map.addSource('planer', { type: 'geojson', data: EMPTY });
  map.addLayer({ id: 'plan-line', type: 'line', source: 'planer',
    layout: { visibility: planToggle.on ? 'visible' : 'none', 'line-join': 'round' },
    paint: { 'line-color': css('--plan'), 'line-width': 2.5, 'line-dasharray': [2, 1.5] } });

  map.on('click', 'fastighet-fill', (e) => { adressMarker?.remove(); openFastighet(e.features[0].properties.beteckning); });
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

// Kartfiltren: formulärets ifyllda fält skickas som parametrar till /api/fastigheter.
const filterForm = $('#filter');
let filterTimer;
function filterQuery() {
  const p = new URLSearchParams([...new FormData(filterForm)].filter(([, v]) => v.trim()));
  $('#filter-count').textContent = p.size ? `(${p.size})` : '';
  return p.size ? `&${p}` : '';
}
filterForm.addEventListener('input', () => { clearTimeout(filterTimer); filterTimer = setTimeout(loadVisible, 300); });
filterForm.addEventListener('reset', () => setTimeout(loadVisible));   // efter att fälten tömts
filterForm.addEventListener('submit', (e) => e.preventDefault());

let loadSeq = 0;
async function loadVisible() {
  const tooFar = map.getZoom() < MIN_ZOOM;
  $('#zoom-hint').hidden = !tooFar;
  const seq = ++loadSeq;
  if (tooFar) {
    $('#filter-hits').textContent = 'Zooma in för att se träffar';
    map.getSource('fastigheter').setData(EMPTY);
    return map.getSource('planer').setData(EMPTY);
  }
  const b = map.getBounds();
  const bbox = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()].map((n) => n.toFixed(5)).join(',');
  const [fc, planer] = await Promise.all([api(`/api/fastigheter?bbox=${bbox}${filterQuery()}`), planToggle.on ? api(`/api/planer?bbox=${bbox}`) : EMPTY]);
  if (seq !== loadSeq) return;
  for (const { properties: p } of fc.features) { p.anv_kat = anvKat(p.typ); p.agar_kat = agarKat(p.agartyp); }
  const n = fc.features.length;
  $('#filter-hits').textContent = `${fc.truncated ? 'Minst ' : ''}${n.toLocaleString('sv-SE')} ${n === 1 ? 'fastighet' : 'fastigheter'} i kartutsnittet`;
  map.getSource('fastigheter').setData(fc);
  map.getSource('planer').setData(planer);
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
$('#close').addEventListener('click', () => { $('#panel').hidden = true; select(null); adressMarker?.remove(); });

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

// Det de flesta letar efter, överst: [[etikett, värde, undertext], ...]
const facts = (items) => `<div class="facts">${items.map(([label, value, sub]) =>
  `<div class="fact"><div class="stat-label">${label}</div><div class="fact-value">${value}</div>${sub ? `<div class="fact-sub">${sub}</div>` : ''}</div>`).join('')}</div>`;

// adress: söktexten när fastigheten öppnades från en adressträff.
async function openFastighet(bet, adress) {
  const f = await apiPanel(`/api/fastighet/${encodeURIComponent(bet)}`);
  if (!f) return;
  select(f.beteckning);
  // Senaste taxeringsåret: värdet är summan av fastighetens taxeringsenheter.
  const ar = f.taxering[0]?.ar;
  const senaste = f.taxering.filter((t) => t.ar === ar);
  const varde = senaste.reduce((s, t) => s + (t.varde_tkr ?? 0), 0);
  const kop = f.transaktioner.find((x) => x.kopeskilling_kr != null);
  // Nyckeltal bara när köpet gällde hela fastigheten och bara den (inte en andel eller en paketaffär).
  const paket = kop?.i_affar > 1;
  const helKop = kop && (!kop.andel || kop.andel === '1/1') && !paket;
  // Lagfarna ägare, annars ägarna i taxeringen.
  const agare = f.agare.length ? f.agare
    : [...new Map(senaste.filter((t) => t.agare_orgnr).map((t) => [t.agare_orgnr, { orgnr: t.agare_orgnr, namn: t.agare_namn }])).values()];
  const anvandning = [...new Set(senaste.map((t) => t.typ).filter(Boolean))];
  const rubrik = adress ?? f.adresser[0] ?? f.beteckning;
  const ovriga = f.adresser.filter((a) => a !== rubrik);
  showPanel(`
    <h2>${esc(rubrik)}${demoTag(f.demo)}</h2>
    <div class="meta">${rubrik === f.beteckning ? '' : `${esc(f.beteckning)} · `}${esc(f.kommun ?? '')}</div>
    ${ovriga.length ? `<div class="meta small">Även ${esc(ovriga.join(', '))}</div>` : ''}
    ${facts([
      ['Ägare', agare.length ? bolagLink(agare[0].orgnr, agare[0].namn, agare[0].demo) : '–',
        [agare.length > 1 ? `och ${agare.length - 1} till, se nedan` : agare.length ? fmtOrgnr(agare[0].orgnr) : 'Väntar på uppgifter från Lantmäteriet',
          agare[0]?.inskrivningsdag ? `ägare sedan ${esc(agare[0].inskrivningsdag)}` : ''].filter(Boolean).join(' · ')],
      ['Användning', anvandning.length ? esc(anvandning.join(' · ')) : '–', anvandning.length ? `Enligt taxeringen ${ar}` : 'Väntar på uppgifter från Skatteverket'],
      ['Senaste köp', kop ? mkr(kop.kopeskilling_kr / 1000) : '–',
        kop ? `${esc(kop.inskrivningsdag ?? '')}${kop.forvarvare_namn ? ` · ${esc(kop.forvarvare_namn)}` : ''}${paket ? ` · paketaffär, ${kop.i_affar} fastigheter` : ''}` : 'Inga registrerade köp'],
    ])}
    ${stats([
      [`Taxeringsvärde${ar ? ` ${ar}` : ''}`, f.taxering.length ? mkr(varde) : '–'],
      ['Areal', f.areal_m2 ? `${Math.round(f.areal_m2).toLocaleString('sv-SE')} m²` : '–'],
      ...(helKop ? [
        ['Köp per m² tomt', f.areal_m2 ? kr(kop.kopeskilling_kr / f.areal_m2) : '–'],
        // K/T: köpeskilling delad med taxeringsvärde.
        ['K/T-kvot', varde ? (kop.kopeskilling_kr / (varde * 1000)).toLocaleString('sv-SE', { maximumFractionDigits: 2 }) : '–'],
      ] : []),
    ])}
    <h3>Detaljplan</h3>
    ${table('<th>Plan</th><th class="num">Laga kraft</th>', f.planer.map((p) =>
      `<tr><td><strong>${esc(PLANTYP[p.typ] ?? p.typ)}</strong>${p.namn ? ` · ${esc(p.namn)}` : ''}${demoTag(p.demo)}
        <div class="muted small">${esc(p.planid ?? '')}</div></td><td class="num">${esc(p.datum ?? '')}</td></tr>`),
      'Väntar på uppgifter från Lantmäteriet.')}
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
    <p class="muted small" style="margin-top:16px">Gränser: ${f.kalla === 'demo' ? 'OpenStreetMap (exempel)' : 'Lantmäteriet'}${f.planer.length ? ` · planer: ${f.planer.some((p) => p.demo) ? 'påhittade (exempel)' : 'Lantmäteriet'}` : ''}${f.adresser.length ? ' · adresser: © OpenStreetMap-bidragsgivare' : ''}</p>
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
  if (r.adresser.length) {
    items.push('<li class="group">Adresser</li>');
    for (const a of r.adresser) items.push(`<li data-kind="a" data-id="${esc(a.beteckning ?? '')}" data-adress="${esc(a.adress)}" data-lonlat="${a.lon},${a.lat}">${esc(a.adress)}${a.ort ? ` <span class="muted small">${esc(a.ort)}</span>` : ''}</li>`);
  }
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
  else if (li.dataset.kind === 'a') openAdress(li.dataset.adress, li.dataset.lonlat.split(',').map(Number), li.dataset.id);
  else { flyToBbox(li.dataset.bbox); openFastighet(li.dataset.id); }
});

// Adressträff: flyg dit, markera punkten och öppna fastigheten den ligger på.
let adressMarker;
function openAdress(adress, lonlat, bet) {
  map.flyTo({ center: lonlat, zoom: Math.max(map.getZoom(), 17) });
  adressMarker ??= new maplibregl.Marker({ color: getComputedStyle(document.body).getPropertyValue('--accent').trim() || '#0369A1' });
  adressMarker.setLngLat(lonlat).addTo(map);
  if (bet) return openFastighet(bet, adress);
  select(null);
  showPanel(`
    <h2>${esc(adress)}</h2>
    <p class="empty">Ingen fastighet i Horos på den här adressen. Horos visar bara fastigheter som ägs
      av bolag, föreningar och andra juridiska personer, och bara i Stockholms kommun.</p>`);
}

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
      <dt>Planer</dt><dd>Lantmäteriet, Markreglerande bestämmelse</dd>
      <dt>Adresser</dt><dd>© OpenStreetMap-bidragsgivare (ODbL)</dd>
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

// Status och demoflagga.
const statusP = api('/api/status');
statusP.then((s) => {
  $('#demo-banner').hidden = !s.demo;
  const n = (x) => x.toLocaleString('sv-SE');
  $('#counts').textContent = s.demo
    ? `${n(s.demo)} exempelfastigheter · ${n(s.bolag)} bolag`
    : `${n(s.fastigheter)} fastigheter · ${n(s.bolag)} bolag · ${n(s.transaktioner)} överlåtelser`;
  basemap.addHistoriska(s.historiska ?? []);
  for (const t of s.typer ?? []) filterForm.anv.add(new Option(t, t));
  for (const t of s.agartyper ?? []) filterForm.jur.add(new Option(t, t));
});

// Väljare i panelvyerna: <select> med tomt värde = alla.
const options = (list, value, alla) => [alla != null ? `<option value="">${esc(alla)}</option>` : '',
  ...list.map((o) => { const [v, text] = Array.isArray(o) ? o : [o, o];
    return `<option value="${esc(v)}"${String(v) === String(value ?? '') ? ' selected' : ''}>${esc(text)}</option>`; })].join('');
const field = (label, name, opts) => `<label>${label}<select name="${name}">${opts}</select></label>`;
const bar = (andel) => `<div class="bar"><i style="width:${Math.max(1, Math.round(andel * 100))}%"></i></div>`;
const fastighetLink = (r) => `<a data-fastighet="${esc(r.beteckning)}" ${bboxAttr(r)}>${esc(r.beteckning)}</a>`
  + (r.antal > 1 ? ` <span class="muted small">+ ${r.antal - 1} till</span>` : '');
const affarRad = (r) => `<tr><td class="num">${esc(r.dag ?? '')}</td>
  <td>${fastighetLink(r)}<div class="muted small">${r.orgnr ? bolagLink(r.orgnr, r.namn, r.demo) : '–'}</div></td>
  <td class="num">${mkr(r.kr / 1000)}</td></tr>`;

// Affärer: volym, antal och de senaste och största köpen, som Datschas transaktionsöversikt.
async function openAffarer(p = {}) {
  const [s, a] = await Promise.all([statusP, apiPanel(`/api/affarer?${new URLSearchParams(p)}`)]);
  if (!a) return;
  select(null);
  const perKat = new Map();
  for (const t of a.perTyp) {
    const k = anvKat(t.typ), v = perKat.get(k) ?? { antal: 0, kr: 0 };
    perKat.set(k, { antal: v.antal + t.antal, kr: v.kr + (t.kr ?? 0) });
  }
  const kat = [...perKat].sort((x, y) => y[1].kr - x[1].kr);
  const n = (x) => x.toLocaleString('sv-SE');
  showPanel(`
    <h2>Affärer</h2>
    <div class="meta">Köp med köpeskilling ur lagfarterna. En paketaffär räknas en gång.</div>
    <form class="view-form" data-view="affarer">
      ${field('Kommun', 'kommun', options(s.kommuner ?? [], a.kommun, 'Alla kommuner'))}
      ${field('År', 'ar', options(a.arLista, a.ar))}
      ${field('Köpeskilling', 'min', options([[0, 'Alla affärer'], [10, 'Över 10 Mkr'], [40, 'Över 40 Mkr'], [100, 'Över 100 Mkr']], a.min))}
    </form>
    ${a.ar ? `
    ${stats([[`Volym ${a.ar}`, mkr((a.summa.kr ?? 0) / 1000)], [`Affärer ${a.ar}`, n(a.summa.antal)],
      ['Senaste 30 dagarna', `${n(a.dagar30.antal)} st · ${mkr((a.dagar30.kr ?? 0) / 1000)}`]])}
    <h3>Per användning ${a.ar}</h3>
    ${table('<th>Användning</th><th class="num">Affärer</th><th class="num">Volym</th>', kat.map(([k, v]) =>
      `<tr><td>${esc(k)}${bar(v.kr / (a.summa.kr || 1))}</td><td class="num">${n(v.antal)}</td><td class="num">${mkr(v.kr / 1000)}</td></tr>`), '')}
    <h3>Största affärerna ${a.ar}</h3>
    ${table('<th class="num">Datum</th><th>Fastighet och köpare</th><th class="num">Pris</th>', a.storsta.map(affarRad), '')}
    <h3>Senaste affärerna ${a.ar}</h3>
    ${table('<th class="num">Datum</th><th>Fastighet och köpare</th><th class="num">Pris</th>', a.senaste.map(affarRad), '')}
    ` : '<p class="empty">Inga registrerade köp ännu. Köpeskillingar läses in när Lantmäteriet har svarat.</p>'}
  `);
}

// Största fastighetsägare efter antal, tomtareal eller taxeringsvärde.
async function openAgare(p = {}) {
  const [s, r] = await Promise.all([statusP, apiPanel(`/api/storsta-agare?${new URLSearchParams(p)}`)]);
  if (!r) return;
  select(null);
  const n = (x) => (x == null ? '–' : Math.round(x).toLocaleString('sv-SE'));
  const areal = r.efter === 'areal';   // tredje kolumnen: tomtareal, annars taxeringsvärde
  showPanel(`
    <h2>Största ägare</h2>
    <div class="meta">Juridiska personer med lagfart. Samägda fastigheter räknas fullt för varje ägare.</div>
    <form class="view-form" data-view="agare">
      ${field('Kommun', 'kommun', options(s.kommuner ?? [], r.kommun, 'Alla kommuner'))}
      ${field('Användning', 'anv', options(s.typer ?? [], r.anv, 'Alla'))}
      ${field('Rangordna efter', 'efter', options([['antal', 'Antal fastigheter'], ['areal', 'Tomtareal'], ['varde', 'Taxeringsvärde']], r.efter))}
    </form>
    ${table(`<th>Ägare</th><th class="num">Antal</th><th class="num">${areal ? 'Areal' : 'Värde'}</th>`, r.agare.map((a, i) =>
      `<tr><td><span class="muted small">${i + 1}.</span> ${bolagLink(a.orgnr, a.namn, a.demo)}<div class="muted small">${esc(a.jurform ?? '')}</div></td>
        <td class="num">${n(a.antal)}</td><td class="num">${areal ? `${n(a.areal_m2)} m²` : mkr(a.varde_tkr)}</td></tr>`),
      'Inga kända ägare ännu. Ägaruppgifter läses in när Lantmäteriet har svarat.')}
  `);
}

const VIEWS = { '#om': openOm, '#affarer': openAffarer, '#agare': openAgare };
$('#panel').addEventListener('change', (e) => {
  const form = e.target.closest('form[data-view]');
  if (form) VIEWS[`#${form.dataset.view}`](Object.fromEntries([...new FormData(form)].filter(([, v]) => v !== '')));
});
for (const a of document.querySelectorAll('.links a[href^="#"]')) {
  a.addEventListener('click', (e) => { e.preventDefault(); history.replaceState(null, '', a.hash); VIEWS[a.hash](); });
}
VIEWS[location.hash]?.();
addEventListener('hashchange', () => VIEWS[location.hash]?.());
