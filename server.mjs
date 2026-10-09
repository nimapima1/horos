// Liten server utan beroenden: statiska filer från public/ + JSON-API.
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, extname, join, normalize, sep } from 'node:path';
import { openDb, ROOT, normOrgnr, normBeteckning, DATA_TABLES, harJuridiskAgare } from './lib/db.mjs';
import { pointInGeom } from './lib/geo.mjs';

const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? '127.0.0.1';
const PUBLIC = join(ROOT, 'public');
const MAX_FEATURES = 5000;
// PUBLIC_MODE=1 i produktion: databasen öppnas skrivskyddad och kontrolleras vid start.
const PUBLIC_MODE = process.env.PUBLIC_MODE === '1';
const TRUST_PROXY = process.env.TRUST_PROXY === '1';   // bakom Caddy: läs klient-IP från X-Forwarded-For
const db = openDb({ readOnly: PUBLIC_MODE });
const hasTable = (name) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE name = ?").get(name);
const HAS_FTS = hasTable('bolag_fts');
const HAS_ADRESS = hasTable('adress_fts');

// Spärr för åtagandet i ansökan till Lantmäteriet: publikt får bara fastigheter med
// juridisk ägare visas, och ingen exempeldata. Servern startar inte annars.
if (PUBLIC_MODE) {
  const fel = [];
  const demo = db.prepare(`SELECT ${DATA_TABLES.map((t) => `(SELECT count(*) FROM ${t} WHERE demo = 1)`).join(' + ')} AS n`).get().n;
  if (demo) fel.push(`${demo} rader exempeldata`);
  const utanAgare = db.prepare(`SELECT count(*) AS n FROM fastighet f WHERE NOT ${harJuridiskAgare()}`).get().n;
  if (utanAgare) fel.push(`${utanAgare} fastigheter utan känd juridisk ägare`);
  if (hasTable('har_privat_agare')) fel.push('tabellen har_privat_agare finns (bygg databasen med scripts/build-public.mjs)');
  if (fel.length) {
    console.error(`Vägrar starta i publikt läge: ${fel.join('; ')}.`);
    process.exit(1);
  }
}

// Enkel hastighetsbegränsning per IP (skyddar en liten server mot massnedladdning).
// Kartrutor har en egen, högre gräns eftersom en kartvy hämtar många på en gång.
const RATE = { windowMs: 10_000, api: Number(process.env.RATE_MAX ?? 200), tiles: Number(process.env.RATE_TILES ?? 800) };
const hits = new Map();
function rateLimited(req, bucket) {
  const ip = (TRUST_PROXY && req.headers['x-forwarded-for']?.split(',')[0].trim()) || req.socket.remoteAddress;
  const key = `${bucket}:${ip}`;
  const now = Date.now();
  const h = hits.get(key);
  if (!h || now - h.start > RATE.windowMs) { hits.set(key, { start: now, n: 1 }); return false; }
  return ++h.n > RATE[bucket];
}
setInterval(() => {
  const now = Date.now();
  for (const [key, h] of hits) if (now - h.start > RATE.windowMs) hits.delete(key);
}, 60_000).unref();

// --- Satellitbild ------------------------------------------------------------
// Tills Lantmäteriets ortofoto finns: Sentinel-2 cloudless från EOX (10 m, fritt för ideellt
// bruk, CC BY-NC-SA 4.0). Rutorna hämtas via servern så att besökarnas IP-adresser inte når EOX,
// och cachas i minnet. Ortofoto läggs senare som filer under TILES_DIR och används då i stället.
const SATELLIT_UPSTREAM = 'https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2025_3857/default/g/{z}/{y}/{x}.jpg';
const SATELLIT_MAXZOOM = 15;
const tileCache = new Map();          // enkel LRU: Map behåller insättningsordning
const TILE_CACHE_MAX = 2000;
async function satellitTile(res, z, x, y) {
  if (z > SATELLIT_MAXZOOM || x >= 2 ** z || y >= 2 ** z) return [404, { error: 'ingen ruta' }];
  const key = `${z}/${x}/${y}`;
  let buf = tileCache.get(key);
  if (buf) {
    tileCache.delete(key);
  } else {
    const url = SATELLIT_UPSTREAM.replace('{z}', z).replace('{x}', x).replace('{y}', y);
    const up = await fetch(url, { signal: AbortSignal.timeout(8000), headers: { 'user-agent': 'horos/0.1 (ideell fastighetskarta)' } });
    if (!up.ok) return [502, { error: 'satellitbilden är inte tillgänglig just nu' }];
    buf = Buffer.from(await up.arrayBuffer());
    if (tileCache.size >= TILE_CACHE_MAX) tileCache.delete(tileCache.keys().next().value);
  }
  tileCache.set(key, buf);
  res.writeHead(200, { 'content-type': 'image/jpeg', 'cache-control': 'public, max-age=604800' });
  res.end(buf);
}

// --- Historiska ortofoton (Lantmäteriet, CC0) ----------------------------------
// WMS med Basic-inloggning (Geotorget-kontot, GEOTORGET_USER/GEOTORGET_PASS i secrets.env).
// Rutorna hämtas via servern (inloggningen syns aldrig i webbläsaren) och sparas på disk i
// CACHE_DIR, vilket CC0 tillåter och som skonar Lantmäteriets tjänst. Bara Stockholmsområdet.
const HIST_UPSTREAM = 'https://maps.lantmateriet.se/historiska-ortofoton/wms/v1';
const HIST_LAYERS = {
  1960: 'OI.Histortho_60', 1975: 'OI.Histortho_75',
  ...Object.fromEntries([1993, 1994, 1995, 1996, 1997, 1998, 1999, 2000, 2001].map((y) => [y, `OI.Histortho_bw_${y}`])),
  ...Object.fromEntries([2002, 2003, 2004, 2005].map((y) => [y, `OI.Histortho_color_${y}`])),
};
const HIST_AUTH = process.env.GEOTORGET_USER && process.env.GEOTORGET_PASS
  ? `Basic ${Buffer.from(`${process.env.GEOTORGET_USER}:${process.env.GEOTORGET_PASS}`).toString('base64')}`
  : null;
const HIST_ZOOM = [10, 18];
const STOCKHOLM = { minLon: 17.5, maxLon: 18.75, minLat: 59.05, maxLat: 59.6 };
const CACHE_DIR = process.env.CACHE_DIR ?? join(ROOT, 'data', '_cache');
const WORLD = 20037508.342789244;   // halva jordomkretsen i EPSG:3857

const tileLonLat = (z, x, y) => {
  const n = 2 ** z;
  const lon = (x / n) * 360 - 180;
  const lat = (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) * 180) / Math.PI;
  return [lon, lat];
};

async function historiskTile(res, ar, z, x, y) {
  const layer = HIST_LAYERS[ar];
  if (!HIST_AUTH) return [503, { error: 'Historiska flygfoton är inte konfigurerade på servern.' }];
  if (!layer || z < HIST_ZOOM[0] || z > HIST_ZOOM[1] || x >= 2 ** z || y >= 2 ** z) return [404, { error: 'ingen ruta' }];
  const [w, n] = tileLonLat(z, x, y), [e, s] = tileLonLat(z, x + 1, y + 1);
  if (e < STOCKHOLM.minLon || w > STOCKHOLM.maxLon || n < STOCKHOLM.minLat || s > STOCKHOLM.maxLat) {
    return [404, { error: 'utanför Stockholmsområdet' }];
  }
  const file = join(CACHE_DIR, 'historisk', String(ar), String(z), String(x), `${y}.jpg`);
  let buf = await readFile(file).catch(() => null);
  if (!buf) {
    const size = (2 * WORLD) / 2 ** z;
    const bbox = [-WORLD + x * size, WORLD - (y + 1) * size, -WORLD + (x + 1) * size, WORLD - y * size];
    const url = `${HIST_UPSTREAM}?SERVICE=WMS&VERSION=1.1.1&REQUEST=GetMap&LAYERS=${layer}&STYLES=&SRS=EPSG:3857`
      + `&BBOX=${bbox.join(',')}&WIDTH=256&HEIGHT=256&FORMAT=image/jpeg`;
    const up = await fetch(url, { signal: AbortSignal.timeout(15000), headers: { authorization: HIST_AUTH, 'user-agent': 'horos/0.1 (ideell fastighetskarta)' } });
    if (!up.ok || !up.headers.get('content-type')?.startsWith('image/')) {
      return [502, { error: `flygfotot är inte tillgängligt just nu (${up.status})` }];
    }
    buf = Buffer.from(await up.arrayBuffer());
    mkdir(dirname(file), { recursive: true }).then(() => writeFile(file, buf)).catch((err) => console.error('cache:', err.message));
  }
  res.writeHead(200, { 'content-type': 'image/jpeg', 'cache-control': 'public, max-age=2592000' });
  res.end(buf);
}

// --- Frågor ------------------------------------------------------------------
// Summan av fastighetens taxeringsvärden det senaste taxeringsåret (alias f = fastighet).
const SENASTE_VARDE = `(SELECT sum(t.varde_tkr) FROM taxering t WHERE t.beteckning = f.beteckning
  AND t.ar = (SELECT max(ar) FROM taxering WHERE beteckning = f.beteckning))`;

// Totalt minus exempeldata: count(*) utan filter går på det lilla primärindexet och
// demo = 1 på det partiella indexet, i stället för att läsa alla 2,2 miljoner bolagsrader.
const countReal = (t) => `(SELECT count(*) FROM ${t}) - (SELECT count(*) FROM ${t} WHERE demo = 1)`;
const counts = db.prepare(`SELECT ${countReal('bolag')} AS bolag, ${countReal('fastighet')} AS fastigheter,
  ${countReal('taxering')} AS taxeringar, ${countReal('agande')} AS agande,
  ${countReal('transaktion')} AS transaktioner, (SELECT count(*) FROM fastighet WHERE demo = 1) AS demo`);

const q = {
  inBbox: db.prepare(`
    SELECT f.beteckning, f.geojson, f.demo, ${SENASTE_VARDE} AS varde_tkr,
      (SELECT b.namn FROM agande a JOIN bolag b ON b.orgnr = a.orgnr
         WHERE a.beteckning = f.beteckning LIMIT 1) AS agare
    FROM fastighet f
    WHERE f.maxx >= ? AND f.minx <= ? AND f.maxy >= ? AND f.miny <= ?
    LIMIT ${MAX_FEATURES + 1}`),
  fastighet: db.prepare('SELECT beteckning, kommun, areal_m2, kalla, demo FROM fastighet WHERE beteckning = ?'),
  taxering: db.prepare(`SELECT t.*, b.namn AS agare_namn FROM taxering t
    LEFT JOIN bolag b ON b.orgnr = t.agare_orgnr
    WHERE t.beteckning = ? ORDER BY t.ar DESC`),
  agare: db.prepare(`SELECT a.orgnr, a.andel, a.inskrivningsdag, b.namn, b.jurform, b.demo
    FROM agande a LEFT JOIN bolag b ON b.orgnr = a.orgnr WHERE a.beteckning = ?`),
  transaktioner: db.prepare(`SELECT x.*, b.namn AS forvarvare_namn FROM transaktion x
    LEFT JOIN bolag b ON b.orgnr = x.forvarvare_orgnr
    WHERE x.beteckning = ? ORDER BY x.inskrivningsdag DESC`),
  bolag: db.prepare('SELECT * FROM bolag WHERE orgnr = ?'),
  bolagFastigheter: db.prepare(`
    SELECT DISTINCT f.beteckning, f.areal_m2, f.minx, f.miny, f.maxx, f.maxy, ${SENASTE_VARDE} AS varde_tkr
    FROM fastighet f
    WHERE f.beteckning IN (SELECT beteckning FROM agande WHERE orgnr = ?
                           UNION SELECT beteckning FROM taxering WHERE agare_orgnr = ?)
    ORDER BY varde_tkr DESC NULLS LAST LIMIT 500`),
  // Fulltext via bolag_fts (byggs av import:bolag, build-public och demo-data).
  sokBolag: HAS_FTS
    ? db.prepare(`SELECT b.orgnr, b.namn, b.postort, b.demo, b.avregistrerad
        FROM bolag_fts JOIN bolag b ON b.rowid = bolag_fts.rowid WHERE bolag_fts MATCH ? LIMIT 300`)
    : db.prepare('SELECT orgnr, namn, postort, demo, avregistrerad FROM bolag WHERE namn LIKE ? LIMIT 300'),
  sokFastighet: db.prepare(`SELECT beteckning, minx, miny, maxx, maxy FROM fastighet
    WHERE beteckning LIKE ? ORDER BY length(beteckning) LIMIT 10`),
  sokAdress: HAS_ADRESS && db.prepare(`SELECT a.gata, a.nummer, a.postnr, a.ort, a.lon, a.lat
    FROM adress_fts JOIN adress a ON a.id = adress_fts.rowid WHERE adress_fts MATCH ? LIMIT 200`),
  fastighetVidPunkt: db.prepare(`SELECT beteckning, geojson FROM fastighet
    WHERE minx <= ? AND maxx >= ? AND miny <= ? AND maxy >= ? LIMIT 100`),
  adresserIBbox: HAS_ADRESS && db.prepare(`SELECT gata, nummer, lon, lat FROM adress
    WHERE lon BETWEEN ? AND ? AND lat BETWEEN ? AND ? LIMIT 2000`),
  fastighetGeom: db.prepare('SELECT geojson, minx, miny, maxx, maxy FROM fastighet WHERE beteckning = ?'),
  export: db.prepare(`
    SELECT f.beteckning, f.kommun, f.areal_m2, f.geojson,
      (SELECT group_concat(a.orgnr, '|') FROM agande a WHERE a.beteckning = f.beteckning) AS agare_orgnr,
      (SELECT group_concat(coalesce(b.namn, ''), '|') FROM agande a LEFT JOIN bolag b ON b.orgnr = a.orgnr
         WHERE a.beteckning = f.beteckning) AS agare_namn,
      (SELECT max(ar) FROM taxering WHERE beteckning = f.beteckning) AS taxeringsar,
      ${SENASTE_VARDE} AS taxeringsvarde_tkr,
      (SELECT inskrivningsdag FROM transaktion x WHERE x.beteckning = f.beteckning
         ORDER BY inskrivningsdag DESC LIMIT 1) AS senaste_overlatelse,
      (SELECT kopeskilling_kr FROM transaktion x WHERE x.beteckning = f.beteckning
         ORDER BY inskrivningsdag DESC LIMIT 1) AS senaste_kopeskilling_kr
    FROM fastighet f WHERE f.demo = 0 ORDER BY f.beteckning`),
};

// I publikt läge är databasen skrivskyddad och byts bara ut med en omstart: räkna en gång.
const statusCounts = PUBLIC_MODE ? counts.get() : null;

// Metadata från build-public (saknas i utvecklingsdatabasen).
const META = hasTable('meta')
  ? Object.fromEntries(db.prepare('SELECT nyckel, varde FROM meta').all().map((r) => [r.nyckel, r.varde]))
  : {};
// Fastighetsgränserna kommer från Lantmäteriet och får bara delas vidare som fil om beslutet
// tillåter det; slås på med build-public --export-geometri (eller EXPORT_GEOMETRI=1).
const EXPORT_GEOMETRI = META.export_geometri === '1' || process.env.EXPORT_GEOMETRI === '1';

// Fritext -> FTS5-fråga med prefixmatchning per ord: "vasa kron" -> "vasa"* "kron"*
const ftsQuery = (term) => term.split(/\s+/).filter(Boolean).map((w) => `"${w.replace(/"/g, '')}"*`).join(' ');
const bolagTraff = ({ orgnr, namn, postort, demo }) => ({ orgnr, namn, postort, demo });

function sokBolag(term) {
  return q.sokBolag.all(HAS_FTS ? ftsQuery(term) : `%${term}%`)
    // Aktiva före avregistrerade, kortare namn (närmare träff) först.
    .sort((x, y) => (x.avregistrerad ? 1 : 0) - (y.avregistrerad ? 1 : 0) || x.namn.length - y.namn.length)
    .slice(0, 15)
    .map(bolagTraff);
}

// Fastigheten som adresspunkten ligger på (bbox-kandidater, sedan punkt-i-polygon).
const fastighetVid = (lon, lat) =>
  q.fastighetVidPunkt.all(lon, lon, lat, lat).find((f) => pointInGeom([lon, lat], JSON.parse(f.geojson)))?.beteckning ?? null;

// Adresserna som ligger på fastigheten, t.ex. ["Drottninggatan 53", "Drottninggatan 55"].
function adresserPa(bet) {
  const f = q.adresserIBbox && q.fastighetGeom.get(bet);
  if (!f) return [];
  const geom = JSON.parse(f.geojson);
  const namn = q.adresserIBbox.all(f.minx, f.maxx, f.miny, f.maxy)
    .filter((a) => pointInGeom([a.lon, a.lat], geom)).map((a) => `${a.gata} ${a.nummer}`);
  return [...new Set(namn)].sort((x, y) => x.localeCompare(y, 'sv', { numeric: true })).slice(0, 12);
}

// "drottninggatan 53" -> adresser där ett sökt ord är exakt husnumret först, sedan kortast
// gatunamn. Samma gata + nummer inom ungefär en kilometer visas en gång (OSM har ofta både en
// adresspunkt och en byggnad), men samma gatunamn i två kommuner hålls isär.
function sokAdress(term) {
  if (!q.sokAdress || !/\p{L}/u.test(term)) return [];
  const ord = new Set(term.toLowerCase().split(/\s+/));
  const seen = new Set();
  return q.sokAdress.all(ftsQuery(term))
    .sort((x, y) => ord.has(y.nummer.toLowerCase()) - ord.has(x.nummer.toLowerCase())
      || x.gata.length - y.gata.length || parseInt(x.nummer) - parseInt(y.nummer))
    .filter((a) => {
      const key = `${a.gata}|${a.nummer}|${Math.round(a.lat * 100)}|${Math.round(a.lon * 50)}`.toLowerCase();
      return !seen.has(key) && seen.add(key);
    })
    .slice(0, 6)
    .map(({ gata, nummer, postnr, ort, lon, lat }) => ({
      adress: `${gata} ${nummer}`,
      ort: [postnr && postnr.replace(/^(\d{3})(\d{2})$/, '$1 $2'), ort].filter(Boolean).join(' ') || null,
      lon, lat, beteckning: fastighetVid(lon, lat),
    }));
}

// GeoJSON-feature som sträng: geometrin ligger redan som JSON i databasen och skarvas in
// direkt i stället för att tolkas och serialiseras om för varje fastighet.
const featureJson = (geojson, properties) =>
  `{"type":"Feature","geometry":${geojson},"properties":${JSON.stringify(properties)}}`;

// --- Öppen data: hela den publika datan som CSV (och GeoJSON om tillåtet) -----
const EXPORT_COLS = ['beteckning', 'kommun', 'areal_m2', 'agare_orgnr', 'agare_namn', 'taxeringsar',
  'taxeringsvarde_tkr', 'senaste_overlatelse', 'senaste_kopeskilling_kr'];
const exportCache = new Map();
function buildExport(kind) {
  if (exportCache.has(kind)) return exportCache.get(kind);
  const rows = q.export.all();
  let body;
  if (kind === 'csv') {
    const cell = (v) => (v == null ? '' : /[;"\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
    // BOM + semikolon så att svensk Excel öppnar filen rätt.
    body = '﻿' + [EXPORT_COLS.join(';'), ...rows.map((r) => EXPORT_COLS.map((c) => cell(r[c])).join(';'))].join('\r\n');
  } else {
    const features = rows.map((r) => featureJson(r.geojson, Object.fromEntries(EXPORT_COLS.map((c) => [c, r[c]]))));
    body = `{"type":"FeatureCollection","features":[${features.join(',')}]}`;
  }
  const buf = Buffer.from(body, 'utf8');
  exportCache.set(kind, buf);
  return buf;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2',
};

function json(res, status, body) {
  res.writeHead(status, { 'content-type': MIME['.json'], 'cache-control': 'no-store' });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

// Varje rutt: [mönster, hastighetsgräns, hanterare]. Hanteraren returnerar [status, body]
// (skickas som JSON) eller skriver själv till res (kartrutor, nedladdningar).
const routes = [
  [/^\/api\/status$/, 'api', () => [200, {
    ...(statusCounts ?? counts.get()),
    byggd: META.byggd ?? null,
    export: { csv: true, geojson: EXPORT_GEOMETRI },
    historiska: HIST_AUTH ? Object.keys(HIST_LAYERS).map(Number) : [],
  }]],

  [/^\/api\/fastigheter$/, 'api', (_m, url) => {
    const bbox = (url.searchParams.get('bbox') ?? '').split(',').map(Number);
    if (bbox.length !== 4 || bbox.some(Number.isNaN)) return [400, { error: 'bbox=minLon,minLat,maxLon,maxLat krävs' }];
    const [minx, miny, maxx, maxy] = bbox;
    const rows = q.inBbox.all(minx, maxx, miny, maxy);
    const features = rows.slice(0, MAX_FEATURES).map((r) =>
      featureJson(r.geojson, { beteckning: r.beteckning, varde_tkr: r.varde_tkr, agare: r.agare, demo: r.demo }));
    return [200, `{"type":"FeatureCollection","truncated":${rows.length > MAX_FEATURES},"features":[${features.join(',')}]}`];
  }],

  [/^\/api\/fastighet\/(.+)$/, 'api', (m) => {
    const bet = normBeteckning(decodeURIComponent(m[1]));
    const f = q.fastighet.get(bet);
    if (!f) return [404, { error: 'Fastigheten finns inte' }];
    return [200, { ...f, adresser: adresserPa(bet), taxering: q.taxering.all(bet), agare: q.agare.all(bet), transaktioner: q.transaktioner.all(bet) }];
  }],

  [/^\/api\/bolag\/([\d-]+)$/, 'api', (m) => {
    const orgnr = normOrgnr(m[1]);
    const b = orgnr && q.bolag.get(orgnr);
    if (!b) return [404, { error: 'Bolaget finns inte bland importerade juridiska personer' }];
    return [200, { ...b, fastigheter: q.bolagFastigheter.all(orgnr, orgnr) }];
  }],

  [/^\/api\/sok$/, 'api', (_m, url) => {
    const term = (url.searchParams.get('q') ?? '').trim();
    if (term.length < 2) return [200, { adresser: [], bolag: [], fastigheter: [] }];
    const orgnr = normOrgnr(term);
    const bolag = orgnr ? [q.bolag.get(orgnr)].filter(Boolean).map(bolagTraff) : sokBolag(term);
    return [200, { adresser: orgnr ? [] : sokAdress(term), bolag, fastigheter: q.sokFastighet.all(`%${normBeteckning(term)}%`) }];
  }],

  [/^\/tiles\/satellit\/(\d{1,2})\/(\d{1,6})\/(\d{1,6})\.jpg$/, 'tiles',
    (m, _url, res) => satellitTile(res, ...m.slice(1).map(Number))],

  [/^\/tiles\/historisk\/(\d{4})\/(\d{1,2})\/(\d{1,6})\/(\d{1,6})\.jpg$/, 'tiles',
    (m, _url, res) => historiskTile(res, ...m.slice(1).map(Number))],

  [/^\/data\/horos-fastigheter-stockholm\.(csv|geojson)$/, 'api', (m, _url, res) => {
    const kind = m[1];
    if (kind === 'geojson' && !EXPORT_GEOMETRI) {
      return [403, { error: 'Fastighetsgränserna får inte laddas ner som fil ännu (väntar på Lantmäteriets villkor).' }];
    }
    res.writeHead(200, {
      'content-type': kind === 'csv' ? 'text/csv; charset=utf-8' : 'application/geo+json; charset=utf-8',
      'content-disposition': `attachment; filename="horos-fastigheter-stockholm.${kind}"`,
      'cache-control': 'public, max-age=3600',
    });
    res.end(buildExport(kind));
  }],
];

async function serveStatic(res, pathname) {
  const rel = normalize(pathname === '/' ? '/index.html' : pathname).replace(/^([/\\])+/, '');
  const file = join(PUBLIC, rel);
  if (!file.startsWith(PUBLIC + sep)) return json(res, 403, { error: 'forbidden' });
  try {
    const body = await readFile(file);
    res.writeHead(200, {
      'content-type': MIME[extname(file)] ?? 'application/octet-stream',
      // Versionsfasta bibliotek kan cachas länge, övriga filer valideras om.
      'cache-control': rel.startsWith('vendor') ? 'public, max-age=604800' : 'no-cache',
    });
    res.end(body);
  } catch {
    json(res, 404, { error: 'not found' });
  }
}

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'endast GET' });
  const route = routes.find(([re]) => re.test(url.pathname));
  if (rateLimited(req, route?.[1] ?? 'api')) return json(res, 429, { error: 'för många förfrågningar, försök igen om en stund' });
  try {
    if (route) {
      const out = await route[2](url.pathname.match(route[0]), url, res);
      if (out) json(res, ...out);
      return;
    }
    if (url.pathname.startsWith('/api/')) return json(res, 404, { error: 'okänd endpoint' });
    await serveStatic(res, url.pathname);
  } catch (e) {
    console.error(e);
    json(res, 500, { error: PUBLIC_MODE ? 'internt fel' : String(e.message ?? e) });
  }
}).listen(PORT, HOST, () => console.log(`Horos${PUBLIC_MODE ? ' (publikt läge)' : ''}: http://${HOST}:${PORT}`));
