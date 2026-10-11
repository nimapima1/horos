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
const PUNKT_ZOOM = 10;
const EMPTY = { type: 'FeatureCollection', features: [] };

// Delbar adress: ?l=zoom/lat/lon&f=beteckning&farg=läge och filtren. Vyerna (#om, #affarer, #agare) ligger i hashen.
const START = new URLSearchParams(location.search);
const startLage = (START.get('l') ?? '').split('/').map(Number);
const harStartLage = startLage.length === 3 && startLage.every(Number.isFinite);

const map = new maplibregl.Map({
  container: 'map',
  style: 'https://tiles.openfreemap.org/styles/dark',   // alltid mörk karta, även i ljust läge
  center: harStartLage ? [startLage[2], startLage[1]] : [18.064, 59.334],
  zoom: harStartLage ? startLage[0] : 15,
  attributionControl: { compact: true },
});
map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');

let selected = null;

// Bildlager via vår egen server (se server.mjs), så att besökarnas IP-adresser stannar hos oss.
const BASE = `${location.origin}${location.pathname.replace(/[^/]*$/, '')}`;
const LM_ATTR = 'Flygfoto: <a href="https://www.lantmateriet.se" target="_blank" rel="noopener">© Lantmäteriet</a> (CC0)';
const IMAGERY = {
  satellit: {
    label: 'Satellit 25',
    source: { tiles: [`${BASE}tiles/satellit/{z}/{x}/{y}.jpg`], maxzoom: 15,
      attribution: 'Satellit: <a href="https://cloudless.eox.at" target="_blank" rel="noopener">EOxCloudless</a> by EOX IT Services GmbH (Contains modified Copernicus Sentinel data 2025)' },
    paint: { 'raster-contrast': 0.08, 'raster-saturation': 0.15 },   // lite krispigare Sentinel-bild
  },
};
// Historiska flygfoton som täcker hela Stockholm (Lantmäteriet, CC0). Läggs till om servern har inloggning.
const HISTORISKA = { 2005: 'Foto 2005', 1995: 'Foto 1995', 1975: 'Foto 1975', 1960: 'Foto 1960' };   // kort: kontrollen är smal

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

// Street View för den öppna fastigheten, under Detaljplaner. Två klick: inget laddas från Google förrän
// besökaren klickar på knappen; sedan följer bilden med till nästa fastighet tills rutan stängs.
class StreetView {
  onAdd() {
    this.el = Object.assign(document.createElement('div'), { className: 'maplibregl-ctrl maplibregl-ctrl-group streetview', hidden: true });
    this.el.addEventListener('click', (e) => {
      if (e.target.closest('[data-visa]')) { this.samtycke = true; this.visa(this.src); }
      if (e.target.closest('[data-stang]')) { this.samtycke = false; this.visa(this.src); }
    });
    return this.el;
  }
  onRemove() { this.el.remove(); }
  // p: "lat,lon" för fastigheten, nyckel: Maps Embed API (status.streetview). Utan någon av dem döljs rutan.
  visa(p, nyckel = this.nyckel) {
    this.nyckel = nyckel;
    this.src = p;
    this.el.hidden = !(p && nyckel);
    if (this.el.hidden) return this.el.replaceChildren();
    if (!this.samtycke) {
      this.el.innerHTML = `<button type="button" data-visa
        title="Bilden laddas från Google, som då får din IP-adress och platsen och kan sätta kakor.">Street View</button>`;
      return;
    }
    const iframe = Object.assign(document.createElement('iframe'), {
      src: `https://www.google.com/maps/embed/v1/streetview?key=${encodeURIComponent(nyckel)}&location=${p}&fov=80`,
      title: 'Street View från Google', allowFullscreen: true,
      referrerPolicy: 'strict-origin',   // Google får domänen (för nyckelns hänvisarlås), inte vilken fastighet
    });
    const stang = Object.assign(document.createElement('button'), { type: 'button', textContent: 'Stäng Street View' });
    stang.dataset.stang = '';
    this.el.replaceChildren(iframe, stang);
  }
}
const streetView = new StreetView();
map.addControl(streetView, 'top-right');

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
// Härledda egenskaper för kartfärgningen.
const kategorier = (p) => ({ anv_kat: anvKat(p.typ), agar_kat: agarKat(p.agartyp),
  kvm: p.varde_tkr != null && p.areal_m2 ? (p.varde_tkr * 1000) / p.areal_m2 : null });
const ANV_KAT = ['Bostäder', 'Lokaler', 'Bostäder och lokaler', 'Industri', 'Special', 'Övrigt'];
const AGAR_KAT = ['Aktiebolag', 'Bostadsrättsförening', 'Kommun, region, stat', 'Handels- och kommanditbolag', 'Stiftelse, förening', 'Övrigt'];
const KAT_FARG = ['--c1', '--c2', '--c3', '--c4', '--c5', '--c6'];
const thisYear = new Date().getFullYear();

// Färgläge: [uttryck för fill-color, teckenförklaring [[färgvariabel, text], ...]].
const COLOR_BY = {
  varde: () => [['step', ['coalesce', ['get', 'varde_tkr'], -1],
    css('--v0'), 0, css('--v1'), 25000, css('--v2'), 100000, css('--v3'), 300000, css('--v4')],
  [['--v1', '< 25 Mkr'], ['--v2', '25–100'], ['--v3', '100–300'], ['--v4', '> 300'], ['--v0', 'Saknas']]],
  kvm: () => [['step', ['coalesce', ['get', 'kvm'], -1],
    css('--v0'), 0, css('--v1'), 20000, css('--v2'), 50000, css('--v3'), 100000, css('--v4')],
  [['--v1', '< 20 tkr/m²'], ['--v2', '20–50'], ['--v3', '50–100'], ['--v4', '> 100'], ['--v0', 'Saknas']]],
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
colorBy.value = [START.get('farg'), store.get('horos.farg')].find((v) => COLOR_BY[v]) ?? 'varde';
const valueColor = () => COLOR_BY[colorBy.value]()[0];
function renderLegend() {
  $('#legend-scale').innerHTML = COLOR_BY[colorBy.value]()[1]
    .map(([v, text]) => `<span><i style="background:var(${v})"></i>${esc(text)}</span>`).join('');
}
renderLegend();
colorBy.addEventListener('change', () => {
  store.set('horos.farg', colorBy.value);
  updateUrl();
  renderLegend();
  if (!map.getLayer('punkt')) return;   // kartan laddas fortfarande; lagren skapas med valet
  applyBasemap(basemap.select.value);   // sätter fyll- och linjefärg på nytt
  map.setPaintProperty('fastighet-fill', 'fill-color', valueColor());
  map.setPaintProperty('punkt', 'circle-color', valueColor());
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
    'line-color': ['case', ['any', SEL, HOVER], css('--map-text'), css('--map-kant')],
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
  // Prickar vid låg zoom, klustrade (se loadVisible).
  map.addSource('punkter', { type: 'geojson', data: EMPTY, cluster: true, clusterMaxZoom: 13, clusterRadius: 44 });
  map.addLayer({ id: 'punkt-kluster', type: 'circle', source: 'punkter', filter: ['has', 'point_count'],
    paint: { 'circle-color': css('--c1'), 'circle-opacity': 0.85, 'circle-stroke-width': 2, 'circle-stroke-color': css('--map-kant'),
      'circle-radius': ['step', ['get', 'point_count'], 13, 20, 17, 100, 22, 1000, 28] } });
  map.addLayer({ id: 'punkt-antal', type: 'symbol', source: 'punkter', filter: ['has', 'point_count'],
    layout: { 'text-field': ['get', 'point_count_abbreviated'], 'text-font': ['Noto Sans Regular'], 'text-size': 12 },
    paint: { 'text-color': css('--map-kant') } });
  map.addLayer({ id: 'punkt', type: 'circle', source: 'punkter', filter: ['!', ['has', 'point_count']],
    paint: { 'circle-color': valueColor(), 'circle-radius': 6, 'circle-stroke-width': 1.5, 'circle-stroke-color': css('--map-kant') } });
  map.on('click', 'punkt-kluster', async (e) => {
    const f = e.features[0];
    const zoom = await map.getSource('punkter').getClusterExpansionZoom(f.properties.cluster_id);
    map.easeTo({ center: f.geometry.coordinates, zoom });
  });
  map.on('click', 'punkt', (e) => {
    const f = e.features[0];
    map.easeTo({ center: f.geometry.coordinates, zoom: 16 });
    openFastighet(f.properties.beteckning);
  });
  // Översikt under PUNKT_ZOOM: antal per kommun, ihopslaget till större områden när man zoomar ut.
  map.addSource('kommuner', { type: 'geojson', data: EMPTY, cluster: true, clusterMaxZoom: PUNKT_ZOOM - 1, clusterRadius: 50,
    clusterProperties: { n: ['+', ['get', 'n']] } });
  map.addLayer({ id: 'kommun-kluster', type: 'circle', source: 'kommuner',
    paint: { 'circle-color': css('--c1'), 'circle-opacity': 0.85, 'circle-stroke-width': 2, 'circle-stroke-color': css('--map-kant'),
      'circle-radius': ['step', ['get', 'n'], 13, 100, 17, 1000, 22, 10000, 28] } });
  map.addLayer({ id: 'kommun-antal', type: 'symbol', source: 'kommuner',
    layout: { 'text-field': ['number-format', ['get', 'n'], { locale: 'sv-SE' }], 'text-font': ['Noto Sans Regular'], 'text-size': 12 },
    paint: { 'text-color': css('--map-kant') } });
  map.on('click', 'kommun-kluster', async (e) => {
    const f = e.features[0];
    if (f.properties.cluster_id === undefined) return zoomaTillOmrade(f.properties.kommun);
    const zoom = await map.getSource('kommuner').getClusterExpansionZoom(f.properties.cluster_id);
    map.easeTo({ center: f.geometry.coordinates, zoom });
  });
  for (const id of ['punkt', 'punkt-kluster', 'kommun-kluster']) {
    map.on('mouseenter', id, () => { map.getCanvas().style.cursor = 'pointer'; });
    map.on('mouseleave', id, () => { map.getCanvas().style.cursor = ''; });
  }

  // Markerade fastigheter (ett bolags innehav), se markera().
  map.addLayer({ id: 'markerad-line', type: 'line', source: 'fastigheter', filter: ['in', ['get', 'beteckning'], ['literal', []]],
    paint: { 'line-color': css('--c2'), 'line-width': 3 } });
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
  // Snabbinfo vid hovring (bara med mus): beteckning, ägare, värde och det kartan färgas efter.
  const tip = matchMedia('(hover: hover)').matches
    ? new maplibregl.Popup({ closeButton: false, closeOnClick: false, className: 'tip', offset: 12, maxWidth: '260px' }) : null;
  map.on('mousemove', 'fastighet-fill', (e) => {
    map.getCanvas().style.cursor = 'pointer';
    const p = e.features[0].properties;
    if (e.features[0].id !== hovered) {
      setHover(e.features[0].id);
      const extra = { kvm: p.kvm ? `${kr(p.kvm)}/m² tomt` : null, anv: p.typ, agartyp: p.agartyp, kopar: p.kop_ar ? `Senast köpt ${p.kop_ar}` : 'Inget registrerat köp' }[colorBy.value];
      tip?.setHTML(`<strong>${esc(p.beteckning)}</strong>${p.demo ? demoTag(1) : ''}
        <div>${esc(p.agare ?? 'Ägare saknas')}</div>
        <div class="muted">Taxeringsvärde ${mkr(p.varde_tkr ?? null)}${extra ? ` · ${esc(extra)}` : ''}</div>`);
    }
    tip?.setLngLat(e.lngLat).addTo(map);
  });
  map.on('mouseleave', 'fastighet-fill', () => { map.getCanvas().style.cursor = ''; setHover(null); tip?.remove(); });
  map.on('moveend', loadVisible);
  applyBasemap(basemap.select.value);
  loadVisible();
  if (START.get('f') && !VIEWS[location.hash]) openFastighet(START.get('f'));
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
filterForm.addEventListener('reset', () => setTimeout(() => { fyllKommuner(); loadVisible(); }));   // efter att fälten tömts
// Län och kommun: kommunlistan visar länets kommuner, och kartan zoomar till det valda området.
let kommunInfo = [];
function fyllKommuner() {
  const lan = filterForm.lan.value, vald = filterForm.kommun.value;
  filterForm.kommun.length = 1;
  for (const k of kommunInfo.filter((k) => !lan || k.lan === lan)) filterForm.kommun.add(new Option(k.namn, k.namn));
  filterForm.kommun.value = [...filterForm.kommun.options].some((o) => o.value === vald) ? vald : '';
}
function zoomaTillOmrade(kommun = filterForm.kommun.value) {
  const lan = filterForm.lan.value;
  const k = kommunInfo.filter((x) => (kommun ? x.namn === kommun : lan && x.lan === lan));
  if (k.length) flyToBbox([Math.min(...k.map((x) => x.minx)), Math.min(...k.map((x) => x.miny)),
    Math.max(...k.map((x) => x.maxx)), Math.max(...k.map((x) => x.maxy))].join(','));
}
filterForm.lan.addEventListener('change', () => { fyllKommuner(); zoomaTillOmrade(); });
filterForm.kommun.addEventListener('change', () => zoomaTillOmrade());
filterForm.addEventListener('submit', (e) => e.preventDefault());
// Filter från en delad länk. Användning och ägartyp sätts när listorna har laddats (se status).
for (const el of filterForm.querySelectorAll('input[name]')) el.value = START.get(el.name) ?? '';
if ([...START.keys()].some((k) => filterForm.elements[k])) filterForm.closest('details').open = true;

let loadSeq = 0;
// Orgnr för det markerade bolaget: utzoomat visas då bara dess fastigheter (se markera()).
let markeradOrg = null;
// Från zoom 14 visas fastighetsgränser, från PUNKT_ZOOM prickar (kluster), annars antal per kommun
// (utom ett markerat bolags fastigheter, som visas som prickar på alla nivåer).
async function loadVisible() {
  const z = map.getZoom();
  const lage = z >= MIN_ZOOM ? 'granser' : z >= PUNKT_ZOOM || markeradOrg ? 'punkter' : 'kommuner';
  $('#zoom-hint').hidden = lage === 'granser';
  $('#zoom-hint').textContent = lage === 'kommuner' ? 'Antal fastigheter per kommun. Zooma in för att se dem.'
    : markeradOrg && z < PUNKT_ZOOM ? 'Visar bara bolagets fastigheter. Zooma in för att se alla.'
      : 'Zooma in för att se fastighetsgränser';
  const seq = ++loadSeq;
  updateUrl();
  if (agareUtsnitt && !$('#panel').hidden && $('#panel form[data-view=agare]')) openAgare(agareUtsnitt);
  const b = map.getBounds();
  const bbox = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()].map((n) => n.toFixed(5)).join(',');
  const urval = `bbox=${bbox}${filterQuery()}${lage === 'punkter' && z < PUNKT_ZOOM ? `&org=${markeradOrg}` : ''}`;
  const [fc, pkt, kom, planer] = await Promise.all([
    lage === 'granser' ? api(`/api/fastigheter?${urval}`) : EMPTY,
    lage === 'punkter' ? api(`/api/punkter?${urval}`) : { p: [] },
    lage === 'kommuner' ? api(`/api/kommunkluster?${filterQuery().slice(1)}`) : { k: [] },
    planToggle.on && lage === 'granser' ? api(`/api/planer?bbox=${bbox}`) : EMPTY]);
  if (seq !== loadSeq) return;
  for (const { properties: p } of fc.features) Object.assign(p, kategorier(p));
  const punkter = { type: 'FeatureCollection', features: pkt.p.map(([lon, lat, beteckning, varde_tkr, typ, agartyp, kop_ar, demo, areal_m2]) => ({
    type: 'Feature', geometry: { type: 'Point', coordinates: [lon, lat] },
    properties: { beteckning, varde_tkr, kop_ar, demo, ...kategorier({ typ, agartyp, varde_tkr, areal_m2 }) } })) };
  const kommuner = { type: 'FeatureCollection', features: kom.k.map(([lon, lat, kommun, n]) => ({
    type: 'Feature', geometry: { type: 'Point', coordinates: [lon, lat] }, properties: { kommun, n } })) };
  const n = fc.features.length + punkter.features.length + kom.k.reduce((s, k) => s + k[3], 0);
  const sumTkr = [...fc.features, ...punkter.features].reduce((s, f) => s + (f.properties.varde_tkr ?? 0), 0)
    + kom.k.reduce((s, k) => s + (k[4] ?? 0), 0);
  $('#filter-hits').textContent = `${fc.truncated || pkt.truncated ? 'Minst ' : ''}${n.toLocaleString('sv-SE')} ${n === 1 ? 'fastighet' : 'fastigheter'} ${lage === 'kommuner' ? 'i hela landet' : 'i kartutsnittet'}`
      + (sumTkr ? `, taxerade till ${mkr(sumTkr)}` : '');
  $('#filter-csv').href = `data/horos-traffar.csv?${urval}`;
  $('#filter-csv').hidden = lage === 'kommuner';   // exporten gäller kartutsnittet, som här kan vara hela landet
  map.getSource('fastigheter').setData(fc);
  map.getSource('punkter').setData(punkter);
  map.getSource('kommuner').setData(kommuner);
  map.getSource('planer').setData(planer);
  if (selected) map.setFeatureState({ source: 'fastigheter', id: selected }, { selected: true });
}

function updateUrl() {
  const p = new URLSearchParams([...new FormData(filterForm)].filter(([, v]) => v.trim()));
  const c = map.getCenter();
  p.set('l', `${map.getZoom().toFixed(2)}/${c.lat.toFixed(5)}/${c.lng.toFixed(5)}`);
  if (selected) p.set('f', selected);
  if (colorBy.value !== 'varde') p.set('farg', colorBy.value);
  history.replaceState(null, '', `?${p.toString().replaceAll('%2F', '/')}${location.hash}`);
}

function select(beteckning) {
  if (selected) map.setFeatureState({ source: 'fastigheter', id: selected }, { selected: false });
  selected = beteckning;
  if (selected) map.setFeatureState({ source: 'fastigheter', id: selected }, { selected: true });
  updateUrl();
}

function showPanel(html) {
  streetView.visa(null);   // openFastighet visar den igen för sin fastighet
  $('#panel-body').innerHTML = html;
  $('#panel').hidden = false;
  $('#panel').scrollTop = 0;
}
addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#panel').hidden && !e.target.closest?.('input, select')) $('#close').click(); });
$('#close').addEventListener('click', () => {
  $('#panel').hidden = true;
  streetView.visa(null);
  select(null);
  markera([]);
  adressMarker?.remove();
  rensaVy();
});
// Tar bort vyn (#affarer m.fl.) ur adressen, så att den inte öppnas igen när sidan laddas om.
function rensaVy() {
  if (location.hash) history.replaceState(null, '', location.pathname + location.search);
}

// Ramar in fastigheterna med beteckningarna i lista (tom lista = ingen markering).
function markera(lista, orgnr = null) {
  const andrad = markeradOrg !== orgnr;
  markeradOrg = orgnr;
  if (andrad && map.getSource('fastigheter')) loadVisible();
  if (map.getLayer('markerad-line')) map.setFilter('markerad-line', ['in', ['get', 'beteckning'], ['literal', lista]]);
}

function flyToBbox(bbox) {
  const [a, b, c, d] = bbox.split(',').map(Number);
  // Lämna plats för vänsterkolumnen (på mobil: panelen nedtill).
  const smal = innerWidth <= 640, sida = $('.sidebar').offsetWidth;
  const padding = smal ? { top: 140, bottom: innerHeight * 0.45, left: 30, right: 30 } : { top: 80, bottom: 80, left: sida + 60, right: 80 };
  map.fitBounds([[a, b], [c, d]], { padding, maxZoom: 17 });
}

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
    for (const b of r.bolag) items.push(`<li data-kind="b" data-id="${esc(b.orgnr)}">${esc(b.namn)}${demoTag(b.demo)} <span class="muted small">${fmtOrgnr(b.orgnr)}${b.postort ? ` · ${esc(b.postort)}` : ''}${b.fastigheter ? ` · ${b.fastigheter.toLocaleString('sv-SE')} ${b.fastigheter === 1 ? 'fastighet' : 'fastigheter'}` : ''}</span></li>`);
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
  for (const t of s.lokaltyper ?? []) filterForm.lok.add(new Option(t, t));
  for (const l of s.lan ?? []) filterForm.lan.add(new Option(l.namn, l.kod));
  kommunInfo = s.kommunInfo ?? [];
  for (const [k, text] of s.agarkategorier) filterForm.agkat.add(new Option(text, k));
  for (const [k, text] of s.upplatelseformer) filterForm.rf.add(new Option(text, k));
  // Utan företagsuppgifter (SCB) finns inga lokaltyper eller uppskattad LOA att filtrera på.
  for (const k of ['lok', 'loamin', 'loamax']) filterForm[k].closest('label').hidden = !s.foretag;
  if (START.get('lan')) filterForm.lan.value = START.get('lan');
  fyllKommuner();
  const valda = ['anv', 'jur', 'lok', 'rf', 'kommun', 'agkat', 'lan'].filter((k) => START.get(k));
  for (const k of valda) filterForm[k].value = START.get(k);
  if (valda.length && map.getSource('fastigheter')) loadVisible();   // annars gör kartans load det
});

// Länkar i panelen.
$('#panel').addEventListener('click', (e) => {
  const ram = e.target.closest('[data-ram]');
  if (ram) flyToBbox(ram.dataset.ram);
  if (ram?.dataset.markera) markera(JSON.parse(ram.dataset.markera));   // fastigheterna i ett pressmeddelande
  const copy = e.target.closest('[data-copy]');
  if (copy) {
    navigator.clipboard.writeText(location.href).then(() => { copy.textContent = 'Länken är kopierad'; },
      () => { copy.textContent = 'Kunde inte kopiera, kopiera adressfältet'; });
  }
  const a = e.target.closest('a');
  if (!a) return;
  if (a.dataset.bolag) openBolag(a.dataset.bolag);
  if (a.dataset.fastighet) { flyToBbox(a.dataset.bbox); openFastighet(a.dataset.fastighet); }
});

// Panelvyerna (panel.js): formulär, länkar i sidhuvudet och #-adresser.
$('#panel').addEventListener('change', (e) => {
  const form = e.target.closest('form[data-view]');
  if (form) VIEWS[`#${form.dataset.view}`](Object.fromEntries([...new FormData(form)].filter(([, v]) => v !== '')));
});
for (const a of document.querySelectorAll('.links a[href^="#"]')) {
  a.addEventListener('click', (e) => { e.preventDefault(); history.replaceState(null, '', a.hash); VIEWS[a.hash](); });
}
VIEWS[location.hash]?.();
addEventListener('hashchange', () => VIEWS[location.hash]?.());
