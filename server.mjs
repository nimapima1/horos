// Liten server utan beroenden: statiska filer från public/ + JSON-API.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { openDb, ROOT, normOrgnr, normBeteckning } from './lib/db.mjs';

const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? '127.0.0.1';
const PUBLIC = join(ROOT, 'public');
const MAX_FEATURES = 5000;
// PUBLIC_MODE=1 i produktion: databasen öppnas skrivskyddad och kontrolleras vid start.
const PUBLIC_MODE = process.env.PUBLIC_MODE === '1';
const TRUST_PROXY = process.env.TRUST_PROXY === '1';   // bakom Caddy: läs klient-IP från X-Forwarded-For
const db = openDb({ readOnly: PUBLIC_MODE });
const hasTable = (name) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE name = ?").get(name);

// Spärr för åtagandet i ansökan till Lantmäteriet: publikt får bara fastigheter med
// juridisk ägare visas, och ingen exempeldata. Servern startar inte annars.
if (PUBLIC_MODE) {
  const fel = [];
  const demo = db.prepare(`SELECT (SELECT count(*) FROM fastighet WHERE demo = 1) + (SELECT count(*) FROM bolag WHERE demo = 1)
    + (SELECT count(*) FROM taxering WHERE demo = 1) + (SELECT count(*) FROM agande WHERE demo = 1)
    + (SELECT count(*) FROM transaktion WHERE demo = 1) AS n`).get().n;
  if (demo) fel.push(`${demo} rader exempeldata`);
  const utanAgare = db.prepare(`SELECT count(*) AS n FROM fastighet f
    WHERE NOT EXISTS (SELECT 1 FROM agande a WHERE a.beteckning = f.beteckning)
      AND NOT EXISTS (SELECT 1 FROM taxering t WHERE t.beteckning = f.beteckning AND t.agare_orgnr IS NOT NULL)`).get().n;
  if (utanAgare) fel.push(`${utanAgare} fastigheter utan känd juridisk ägare`);
  if (hasTable('har_privat_agare')) fel.push('tabellen har_privat_agare finns (bygg databasen med scripts/build-public.mjs)');
  if (fel.length) {
    console.error(`Vägrar starta i publikt läge: ${fel.join('; ')}.`);
    process.exit(1);
  }
}

// Enkel hastighetsbegränsning per IP (skyddar en liten server mot massnedladdning).
// Kartrutor har en egen, högre gräns eftersom en kartvy hämtar många på en gång.
const RATE = { windowMs: 10_000, max: Number(process.env.RATE_MAX ?? 200), tiles: Number(process.env.RATE_TILES ?? 800) };
const hits = new Map();
function rateLimited(req, bucket) {
  const ip = (TRUST_PROXY && req.headers['x-forwarded-for']?.split(',')[0].trim()) || req.socket.remoteAddress;
  const key = `${bucket}:${ip}`;
  const now = Date.now();
  const h = hits.get(key);
  if (!h || now - h.start > RATE.windowMs) { hits.set(key, { start: now, n: 1 }); return false; }
  return ++h.n > (bucket === 'tiles' ? RATE.tiles : RATE.max);
}

// --- Satellitbild ------------------------------------------------------------
// Tills Lantmäteriets ortofoto finns: Sentinel-2 cloudless från EOX (10 m, fritt för ideellt
// bruk, CC BY-NC-SA 4.0). Rutorna hämtas via servern så att besökarnas IP-adresser inte når EOX,
// och cachas i minnet. Ortofoto läggs senare som filer under SATELLIT_DIR och används då i stället.
const SATELLIT_UPSTREAM = 'https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2025_3857/default/g/{z}/{y}/{x}.jpg';
const SATELLIT_MAXZOOM = 15;
const tileCache = new Map();          // enkel LRU: Map behåller insättningsordning
const TILE_CACHE_MAX = 2000;
async function serveSatellitTile(res, z, x, y) {
  if (z > SATELLIT_MAXZOOM || x >= 2 ** z || y >= 2 ** z) return json(res, 404, { error: 'ingen ruta' });
  const key = `${z}/${x}/${y}`;
  let buf = tileCache.get(key);
  if (buf) {
    tileCache.delete(key);
    tileCache.set(key, buf);
  } else {
    const url = SATELLIT_UPSTREAM.replace('{z}', z).replace('{x}', x).replace('{y}', y);
    const up = await fetch(url, { signal: AbortSignal.timeout(8000), headers: { 'user-agent': 'horos/0.1 (ideell fastighetskarta)' } });
    if (!up.ok) return json(res, 502, { error: 'satellitbilden är inte tillgänglig just nu' });
    buf = Buffer.from(await up.arrayBuffer());
    tileCache.set(key, buf);
    if (tileCache.size > TILE_CACHE_MAX) tileCache.delete(tileCache.keys().next().value);
  }
  res.writeHead(200, { 'content-type': 'image/jpeg', 'cache-control': 'public, max-age=604800' });
  res.end(buf);
}
setInterval(() => {
  const now = Date.now();
  for (const [ip, h] of hits) if (now - h.start > RATE.windowMs) hits.delete(ip);
}, 60_000).unref();

// Fritext -> FTS5-fråga med prefixmatchning per ord: "vasa kron" -> "vasa"* "kron"*
const ftsQuery = (term) => term.split(/\s+/).filter(Boolean).map((w) => `"${w.replace(/"/g, '')}"*`).join(' ');

function sokBolag(term) {
  const rows = q.sokBolagFts
    ? [...q.sokDemoBolag.all(`%${term}%`), ...q.sokBolagFts.all(ftsQuery(term))]
    : q.sokBolagLike.all(`%${term}%`);
  // Aktiva före avregistrerade, kortare namn (närmare träff) först.
  const seen = new Set();
  return rows
    .filter((r) => !seen.has(r.orgnr) && seen.add(r.orgnr))
    .sort((x, y) => (x.avregistrerad ? 1 : 0) - (y.avregistrerad ? 1 : 0) || x.namn.length - y.namn.length)
    .slice(0, 15)
    .map(({ orgnr, namn, postort, demo }) => ({ orgnr, namn, postort, demo }));
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
};

const q = {
  counts: db.prepare(`SELECT
      (SELECT count(*) FROM bolag WHERE demo = 0)       AS bolag,
      (SELECT count(*) FROM fastighet WHERE demo = 0)   AS fastigheter,
      (SELECT count(*) FROM taxering WHERE demo = 0)    AS taxeringar,
      (SELECT count(*) FROM agande WHERE demo = 0)      AS agande,
      (SELECT count(*) FROM transaktion WHERE demo = 0) AS transaktioner,
      (SELECT count(*) FROM fastighet WHERE demo = 1)   AS demo`),
  inBbox: db.prepare(`
    SELECT f.beteckning, f.geojson, f.demo,
      (SELECT sum(t.varde_tkr) FROM taxering t
         WHERE t.beteckning = f.beteckning
           AND t.ar = (SELECT max(ar) FROM taxering WHERE beteckning = f.beteckning)) AS varde_tkr,
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
    SELECT DISTINCT f.beteckning, f.areal_m2, f.minx, f.miny, f.maxx, f.maxy,
      (SELECT sum(t.varde_tkr) FROM taxering t WHERE t.beteckning = f.beteckning
         AND t.ar = (SELECT max(ar) FROM taxering WHERE beteckning = f.beteckning)) AS varde_tkr
    FROM fastighet f
    WHERE f.beteckning IN (SELECT beteckning FROM agande WHERE orgnr = ?
                           UNION SELECT beteckning FROM taxering WHERE agare_orgnr = ?)
    ORDER BY varde_tkr DESC NULLS LAST LIMIT 500`),
  // Fulltext via bolag_fts (byggs av import:bolag). Exempelbolag ligger utanför indexet.
  sokBolagFts: hasTable('bolag_fts') && db.prepare(`SELECT b.orgnr, b.namn, b.postort, b.demo, b.avregistrerad
    FROM bolag_fts JOIN bolag b ON b.rowid = bolag_fts.rowid WHERE bolag_fts MATCH ? LIMIT 300`),
  sokBolagLike: db.prepare(`SELECT orgnr, namn, postort, demo, avregistrerad FROM bolag
    WHERE namn LIKE ? LIMIT 300`),
  sokDemoBolag: db.prepare(`SELECT orgnr, namn, postort, demo, avregistrerad FROM bolag
    WHERE demo = 1 AND namn LIKE ?`),
  sokFastighet: db.prepare(`SELECT beteckning, minx, miny, maxx, maxy FROM fastighet
    WHERE beteckning LIKE ? ORDER BY length(beteckning) LIMIT 10`),
};

// Metadata från build-public (saknas i utvecklingsdatabasen).
const META = hasTable('meta')
  ? Object.fromEntries(db.prepare('SELECT nyckel, varde FROM meta').all().map((r) => [r.nyckel, r.varde]))
  : {};
// Fastighetsgränserna kommer från Lantmäteriet och får bara delas vidare som fil om beslutet
// tillåter det; slås på med build-public --export-geometri (eller EXPORT_GEOMETRI=1).
const EXPORT_GEOMETRI = META.export_geometri === '1' || process.env.EXPORT_GEOMETRI === '1';

// --- Öppen data: hela den publika datan som CSV (och GeoJSON om tillåtet) -----
const exportRows = db.prepare(`
  SELECT f.beteckning, f.kommun, f.areal_m2, f.geojson,
    (SELECT group_concat(a.orgnr, '|') FROM agande a WHERE a.beteckning = f.beteckning) AS agare_orgnr,
    (SELECT group_concat(coalesce(b.namn, ''), '|') FROM agande a LEFT JOIN bolag b ON b.orgnr = a.orgnr
       WHERE a.beteckning = f.beteckning) AS agare_namn,
    (SELECT max(ar) FROM taxering WHERE beteckning = f.beteckning) AS taxeringsar,
    (SELECT sum(varde_tkr) FROM taxering t WHERE t.beteckning = f.beteckning
       AND t.ar = (SELECT max(ar) FROM taxering WHERE beteckning = f.beteckning)) AS taxeringsvarde_tkr,
    (SELECT inskrivningsdag FROM transaktion x WHERE x.beteckning = f.beteckning
       ORDER BY inskrivningsdag DESC LIMIT 1) AS senaste_overlatelse,
    (SELECT kopeskilling_kr FROM transaktion x WHERE x.beteckning = f.beteckning
       ORDER BY inskrivningsdag DESC LIMIT 1) AS senaste_kopeskilling_kr
  FROM fastighet f WHERE f.demo = 0 ORDER BY f.beteckning`);

const EXPORT_COLS = ['beteckning', 'kommun', 'areal_m2', 'agare_orgnr', 'agare_namn', 'taxeringsar',
  'taxeringsvarde_tkr', 'senaste_overlatelse', 'senaste_kopeskilling_kr'];
const exportCache = new Map();
function buildExport(kind) {
  if (exportCache.has(kind)) return exportCache.get(kind);
  const rows = exportRows.all();
  let body;
  if (kind === 'csv') {
    const cell = (v) => (v == null ? '' : /[;"\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
    // BOM + semikolon så att svensk Excel öppnar filen rätt.
    body = '﻿' + [EXPORT_COLS.join(';'), ...rows.map((r) => EXPORT_COLS.map((c) => cell(r[c])).join(';'))].join('\r\n');
  } else {
    body = JSON.stringify({
      type: 'FeatureCollection',
      features: rows.map((r) => ({
        type: 'Feature',
        geometry: JSON.parse(r.geojson),
        properties: Object.fromEntries(EXPORT_COLS.map((c) => [c, r[c]])),
      })),
    });
  }
  const buf = Buffer.from(body, 'utf8');
  exportCache.set(kind, buf);
  return buf;
}

function serveExport(res, kind) {
  if (kind === 'geojson' && !EXPORT_GEOMETRI) {
    return json(res, 403, { error: 'Fastighetsgränserna får inte laddas ner som fil ännu (väntar på Lantmäteriets villkor).' });
  }
  const buf = buildExport(kind);
  res.writeHead(200, {
    'content-type': kind === 'csv' ? 'text/csv; charset=utf-8' : 'application/geo+json; charset=utf-8',
    'content-disposition': `attachment; filename="horos-fastigheter-stockholm.${kind}"`,
    'cache-control': 'public, max-age=3600',
  });
  res.end(buf);
}

function json(res, status, body) {
  res.writeHead(status, { 'content-type': MIME['.json'], 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

const routes = [
  [/^\/api\/status$/, () => [200, {
    ...q.counts.get(),
    byggd: META.byggd ?? null,
    export: { csv: true, geojson: EXPORT_GEOMETRI },
  }]],

  [/^\/api\/fastigheter$/, (_m, url) => {
    const bbox = (url.searchParams.get('bbox') ?? '').split(',').map(Number);
    if (bbox.length !== 4 || bbox.some(Number.isNaN)) return [400, { error: 'bbox=minLon,minLat,maxLon,maxLat krävs' }];
    const [minx, miny, maxx, maxy] = bbox;
    const rows = q.inBbox.all(minx, maxx, miny, maxy);
    const truncated = rows.length > MAX_FEATURES;
    return [200, {
      type: 'FeatureCollection',
      truncated,
      features: rows.slice(0, MAX_FEATURES).map((r) => ({
        type: 'Feature',
        geometry: JSON.parse(r.geojson),
        properties: { beteckning: r.beteckning, varde_tkr: r.varde_tkr, agare: r.agare, demo: r.demo },
      })),
    }];
  }],

  [/^\/api\/fastighet\/(.+)$/, (m) => {
    const bet = normBeteckning(decodeURIComponent(m[1]));
    const f = q.fastighet.get(bet);
    if (!f) return [404, { error: 'Fastigheten finns inte' }];
    return [200, {
      ...f,
      taxering: q.taxering.all(bet),
      agare: q.agare.all(bet),
      transaktioner: q.transaktioner.all(bet),
    }];
  }],

  [/^\/api\/bolag\/([\d-]+)$/, (m) => {
    const orgnr = normOrgnr(m[1]);
    const b = orgnr && q.bolag.get(orgnr);
    if (!b) return [404, { error: 'Bolaget finns inte bland importerade juridiska personer' }];
    return [200, { ...b, fastigheter: q.bolagFastigheter.all(orgnr, orgnr) }];
  }],

  [/^\/api\/sok$/, (_m, url) => {
    const term = (url.searchParams.get('q') ?? '').trim();
    if (term.length < 2) return [200, { bolag: [], fastigheter: [] }];
    const orgnr = normOrgnr(term);
    const bolag = orgnr
      ? [q.bolag.get(orgnr)].filter(Boolean).map(({ orgnr, namn, postort, demo }) => ({ orgnr, namn, postort, demo }))
      : sokBolag(term);
    const fastigheter = q.sokFastighet.all(`%${normBeteckning(term)}%`);
    return [200, { bolag, fastigheter }];
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
  const tile = url.pathname.match(/^\/tiles\/satellit\/(\d{1,2})\/(\d{1,6})\/(\d{1,6})\.jpg$/);
  if (rateLimited(req, tile ? 'tiles' : 'api')) return json(res, 429, { error: 'för många förfrågningar, försök igen om en stund' });
  try {
    if (tile) return await serveSatellitTile(res, ...tile.slice(1).map(Number));
    const exp = url.pathname.match(/^\/data\/horos-fastigheter-stockholm\.(csv|geojson)$/);
    if (exp) return serveExport(res, exp[1]);
    for (const [re, handler] of routes) {
      const m = url.pathname.match(re);
      if (m) {
        const [status, body] = handler(m, url);
        return json(res, status, body);
      }
    }
    if (url.pathname.startsWith('/api/')) return json(res, 404, { error: 'okänd endpoint' });
    await serveStatic(res, url.pathname);
  } catch (e) {
    console.error(e);
    json(res, 500, { error: PUBLIC_MODE ? 'internt fel' : String(e.message ?? e) });
  }
}).listen(PORT, HOST, () => console.log(`Horos${PUBLIC_MODE ? ' (publikt läge)' : ''}: http://${HOST}:${PORT}`));
