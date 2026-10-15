// Liten server utan beroenden: statiska filer från public/ + JSON-API.
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { csvCell } from './lib/csv.mjs';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { readFile, writeFile, mkdir, statfs } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { dirname, extname, join, normalize, sep } from 'node:path';
import { openDb, ROOT, normOrgnr, normBeteckning, DATA_TABLES, harJuridiskAgare, NYHET_PLATS_UTANFOR, hasColumn, rebuildRtree, rebuildFastighetFts, fastighetsBet } from './lib/db.mjs';
import { avstandM, innerPoints, pointInGeom } from './lib/geo.mjs';
import { LAN, LAN_FOR_KOMMUN, kommunAv, kommunForst } from './lib/kommuner.mjs';
import { MAX_SCENARIO, MAX_SCENARIO_BYTE, giltigtScenario, oppnaScenarier } from './lib/scenarier.mjs';
import { LOKALTYPER } from './lib/lokaltyp.mjs';
import { arFastighetsbolag, tolkaMfn, nyhetsRubrik } from './lib/nyheter.mjs';

const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? '127.0.0.1';
const PUBLIC = join(ROOT, 'public');
const MAX_FEATURES = 5000;
const MAX_PUNKTER = 30000;   // prickar vid låg zoom
// PUBLIC_MODE=1 i produktion: databasen öppnas skrivskyddad och kontrolleras vid start.
const PUBLIC_MODE = process.env.PUBLIC_MODE === '1';
const TRUST_PROXY = process.env.TRUST_PROXY === '1';   // bakom Caddy: läs klient-IP från X-Forwarded-For
const db = openDb({ readOnly: PUBLIC_MODE });
const hasTable = (name) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE name = ?").get(name);
const HAS_FTS = hasTable('bolag_fts');
const HAS_ADRESS = hasTable('adress_fts');
const HAS_PLAN = hasTable('plan');   // saknas i publika databaser byggda före planerna
// Arbetsställen (SCB) med minst en rad: den publika databasen har tabellen men inga rader förrän
// build-public körs med --scb-villkor, och då ska inget om företag visas.
const HAS_AE = hasTable('arbetsstalle') && !!db.prepare('SELECT 1 FROM arbetsstalle LIMIT 1').get();
const HAS_NYHET = hasTable('nyhet');
// Miljö och risk: bara med rader, så att en databas utan importen inte svarar "inga i närheten".
const harRader = (t) => hasTable(t) && !!db.prepare(`SELECT 1 FROM ${t} LIMIT 1`).get();
const HAS_FORORENAT = harRader('fororenat'), HAS_UTSATT = harRader('utsatt_omrade');   // saknas i publika databaser byggda före pressmeddelandena
// Kolumner som saknas i publika databaser byggda före dem (servern läser dem utan att lägga till kolumner).
const HAS_TOMTRATT = hasColumn(db, 'agande', 'tomtratt');
const HAS_AGARKONTROLL = hasColumn(db, 'bolag', 'agarkontroll');

// Rumsliga index. build-public bygger dem i den publika databasen; lokalt byggs de om vid
// start, så att de stämmer efter en import.
// shortcut: ombyggnad vid varje lokal start tar några sekunder med hela landet; flytta till importskripten då.
if (!PUBLIC_MODE) {
  for (const t of ['fastighet', 'plan']) rebuildRtree(db, t);
  rebuildFastighetFts(db);
} else if (!hasTable('fastighet_fts')) {
  // Äldre publika databaser kan också sökas med index, utan att originalet skrivs.
  db.exec(`CREATE VIRTUAL TABLE temp.fastighet_fts USING fts5(beteckning, prefix='2 3');
    INSERT INTO temp.fastighet_fts(rowid, beteckning) SELECT rowid, beteckning FROM main.fastighet;`);
}
// SQL-villkor "bbox överlappar", parametrar (minx, maxx, miny, maxy). Utan R-träd (en äldre
// publik databas) används bbox-kolumnerna direkt.
const overlapar = (table, alias) => (hasTable(`${table}_rtree`)
  ? `${alias}.rowid IN (SELECT id FROM ${table}_rtree WHERE maxx >= ? AND minx <= ? AND maxy >= ? AND miny <= ?)`
  : `${alias}.maxx >= ? AND ${alias}.minx <= ? AND ${alias}.maxy >= ? AND ${alias}.miny <= ?`);

// Spärr för åtagandet i ansökan till Lantmäteriet: publikt får bara fastigheter med
// juridisk ägare visas, och ingen exempeldata. Servern startar inte annars.
if (PUBLIC_MODE) {
  const fel = [];
  const demo = db.prepare(`SELECT ${DATA_TABLES.filter(hasTable).map((t) => `(SELECT count(*) FROM ${t} WHERE demo = 1)`).join(' + ')} AS n`).get().n;
  if (demo) fel.push(`${demo} rader exempeldata`);
  const utanAgare = db.prepare(`SELECT count(*) AS n FROM fastighet f WHERE NOT ${harJuridiskAgare()}`).get().n;
  if (utanAgare) fel.push(`${utanAgare} fastigheter utan känd juridisk ägare`);
  if (HAS_AE) {
    // Arbetsställen: bara juridiska personer och bara på fastigheter som visas.
    const ae = db.prepare(`SELECT count(*) AS n FROM arbetsstalle WHERE substr(orgnr, 3, 1) < '2' OR length(orgnr) != 10
      OR beteckning IS NULL OR beteckning NOT IN (SELECT beteckning FROM fastighet)`).get().n;
    if (ae) fel.push(`${ae} arbetsställen med personnummer eller utan fastighet i Horos`);
  }
  // Pressmeddelandenas platser: bara på fastigheter som visas (åtagandet för belägenhetsadresser).
  const np = HAS_NYHET && db.prepare(`SELECT count(*) AS n FROM nyhet_plats WHERE ${NYHET_PLATS_UTANFOR}`).get().n;
  if (np) fel.push(`${np} platser i pressmeddelanden utan fastighet i Horos`);
  if (hasTable('har_privat_agare')) fel.push('tabellen har_privat_agare finns (bygg databasen med scripts/build-public.mjs)');
  if (fel.length) {
    console.error(`Vägrar starta i publikt läge: ${fel.join('; ')}.`);
    process.exit(1);
  }
}

// --- Scenarier (korta länkar, lib/scenarier.mjs) --------------------------------------
// På servern i systemds STATE_DIRECTORY (StateDirectory=horos-scenarion); utan skrivbar plats inga korta länkar.
const scenarier = oppnaScenarier(process.env.SCENARIO_DB
  ?? (process.env.STATE_DIRECTORY ? join(process.env.STATE_DIRECTORY, 'scenarion.sqlite') : PUBLIC_MODE ? null : join(ROOT, 'data', 'scenarion.sqlite')));

// --- MFN (pressmeddelanden som skickas hit) ------------------------------------------
// MFN skickar varje nytt pressmeddelande som POST till /api/mfn (WebSub, signerat med HMAC-SHA256 i
// X-Hub-Signature med hemligheten MFN_SECRET). Köp och försäljningar sparas med utgivarens org.nr, utan texten,
// i en egen databas i samma skrivbara katalog som scenarierna; cron (deploy/nyheter.sh) för in fastighetsbolagens
// i den publika (arFastighetsbolag i lib/nyheter.mjs). Utan MFN_SECRET finns ingen mottagare.
const MFN_DB = process.env.MFN_DB
  ?? (process.env.STATE_DIRECTORY ? join(process.env.STATE_DIRECTORY, 'mfn.sqlite') : PUBLIC_MODE ? null : join(ROOT, 'data', 'mfn.sqlite'));
// Hela pressmeddelandet med HTML; läses innan signaturen kan kontrolleras. MFN: pressmeddelanden kan vara större
// än 1 MB (2026-10-15), och ett för stort skickas om. Egen hastighetsgräns (RATE.mfn) håller minnet nere.
const MAX_MFN_BYTE = 10 * 1024 * 1024;
const bolagFor = db.prepare('SELECT namn, sni FROM bolag WHERE orgnr = ?');
let qm = null;
try {
  if (process.env.MFN_SECRET && MFN_DB) {
    mkdirSync(dirname(MFN_DB), { recursive: true });
    // Ingen WAL: cron läser filen som en annan användare, skrivskyddat.
    const mdb = new DatabaseSync(MFN_DB);
    mdb.exec(`CREATE TABLE IF NOT EXISTS mfn_nyhet (url TEXT PRIMARY KEY, utgivare TEXT NOT NULL, rubrik TEXT NOT NULL,
      datum TEXT, typ TEXT NOT NULL, pris_kr INTEGER, kommun TEXT, beteckningar TEXT NOT NULL, adresser TEXT NOT NULL,
      mottagen TEXT NOT NULL, orgnr TEXT)`);
    if (!hasColumn(mdb, 'mfn_nyhet', 'orgnr')) mdb.exec('ALTER TABLE mfn_nyhet ADD COLUMN orgnr TEXT');   // tabeller från före 2026-10-12 kl. 14
    qm = mdb.prepare(`INSERT OR REPLACE INTO mfn_nyhet (url, utgivare, rubrik, datum, typ, pris_kr, kommun, beteckningar, adresser, orgnr, mottagen)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`);
  }
} catch (e) {
  console.error(`MFN-mottagaren är avstängd (${MFN_DB}): ${e.message}`);
}
const mfnSignaturOk = (kropp, sig) => {
  const ratt = createHmac('sha256', process.env.MFN_SECRET).update(kropp).digest('hex');
  const fick = String(sig ?? '').replace(/^sha256=/i, '').toLowerCase();
  return fick.length === ratt.length && timingSafeEqual(Buffer.from(fick), Buffer.from(ratt));
};

// Kroppen som Buffer, högst max byte.
async function lasKropp(req, max) {
  const delar = [];
  let n = 0;
  for await (const d of req) {
    if ((n += d.length) > max) return { fel: [413, { error: 'för stort' }] };
    delar.push(d);
  }
  return { kropp: Buffer.concat(delar) };
}

// JSON-kropp på högst max byte. Kräver content-type application/json: ett formulär på en annan sida
// kan inte skicka det utan CORS-förfrågan, som servern inte svarar på.
async function lasJson(req, max) {
  if (!/^application\/json\b/.test(req.headers['content-type'] ?? '')) return { fel: [415, { error: 'application/json krävs' }] };
  const { kropp, fel } = await lasKropp(req, max);
  if (fel) return { fel };
  try { return { varde: JSON.parse(kropp) }; } catch { return { fel: [400, { error: 'ogiltig JSON' }] }; }
}

// Enkel hastighetsbegränsning per IP (skyddar en liten server mot massnedladdning).
// Kartrutor har en egen, högre gräns eftersom en kartvy hämtar många på en gång. Historiska rutor och
// hela databasen som fil har lägre gränser: de hämtas från Lantmäteriet respektive är de största svaren.
const RATE = { windowMs: 10_000, api: Number(process.env.RATE_MAX ?? 200), tiles: Number(process.env.RATE_TILES ?? 800),
  historisk: Number(process.env.RATE_HISTORISK ?? 300), export: Number(process.env.RATE_EXPORT ?? 2),
  spara: Number(process.env.RATE_SPARA ?? 5), mfn: Number(process.env.RATE_MFN ?? 30), sok: Number(process.env.RATE_SOK ?? 20) };
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
// Diskcachen växer inte när det lediga utrymmet understiger gränsen: en full disk stoppar servern.
const CACHE_MIN_LEDIGT = Number(process.env.CACHE_MIN_LEDIGT_GB ?? 10) * 1e9;
let ledigt = { tid: 0, ok: false };
async function diskRymmer() {
  if (Date.now() - ledigt.tid > 60_000) {
    const s = await statfs(CACHE_DIR).catch(() => null);
    ledigt = { tid: Date.now(), ok: !!s && s.bavail * s.bsize > CACHE_MIN_LEDIGT };
  }
  return ledigt.ok;
}

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
    mkdir(dirname(file), { recursive: true }).then(diskRymmer).then((ok) => ok && writeFile(file, buf))
      .catch((err) => console.error('cache:', err.message));
  }
  res.writeHead(200, { 'content-type': 'image/jpeg', 'cache-control': 'public, max-age=2592000' });
  res.end(buf);
}

// --- Frågor ------------------------------------------------------------------
// Summan av fastighetens taxeringsvärden det senaste taxeringsåret (alias f = fastighet).
const SENASTE_VARDE = `(SELECT sum(varde) FROM (SELECT max(t.varde_tkr) AS varde FROM taxering t
  WHERE t.beteckning = f.beteckning AND t.ar = (SELECT max(ar) FROM taxering WHERE beteckning = f.beteckning)
  GROUP BY coalesce(t.taxeringsenhet, t.rowid)))`;
// Fastigheten har taxeringstypen ? det senaste taxeringsåret.
const harTyp = (alias) => `EXISTS (SELECT 1 FROM taxering t WHERE t.beteckning = ${alias}.beteckning AND t.typ = ?
  AND t.ar = (SELECT max(ar) FROM taxering WHERE beteckning = ${alias}.beteckning))`;
// Första taxeringstypen det senaste taxeringsåret (alias f = fastighet).
const SENASTE_TYP = `(SELECT t.typ FROM taxering t WHERE t.beteckning = f.beteckning
  ORDER BY t.ar DESC, t.varde_tkr DESC LIMIT 1)`;

// Fastighetens (alias f) uppskattade LOA från arbetsställena (se lib/lokaltyp.mjs), null utan arbetsställen.
const FASTIGHET_LOA = HAS_AE ? '(SELECT sum(a.loa_m2) FROM arbetsstalle a WHERE a.beteckning = f.beteckning)' : 'NULL';

// Upplåtelseform för fastigheten f: 'tomtratt' om någon har tomträtt, 'aganderatt' om alla innehav är
// kända lagfarter (count(kolumn) räknar bara kända värden), annars null (inga ägare eller okänt).
const UPPLATELSE = HAS_TOMTRATT ? `(SELECT CASE WHEN max(k.tomtratt) = 1 THEN 'tomtratt'
    WHEN count(*) > 0 AND count(k.tomtratt) = count(*) THEN 'aganderatt' END
  FROM agande k WHERE k.beteckning = f.beteckning)` : 'NULL';
const UPPLATELSEFORMER = [['aganderatt', 'Äganderätt'], ['tomtratt', 'Tomträtt']];

// Ägarkategori för bolaget b: myndigheten själv efter juridisk form, bolag som staten, en kommun eller en
// region äger efter SCB:s ägarkontroll (scripts/import-agarkontroll.mjs), annars efter form och bransch.
const AGARKATEGORI_SQL = `CASE
    WHEN b.jurform IN ('Statlig enhet', 'Regional statlig myndighet', 'Allmän försäkringskassa') THEN 'stat'
    WHEN b.jurform IN ('Kommun', 'Kommunalförbund') THEN 'kommun'
    WHEN b.jurform = 'Region' THEN 'region'
    ${HAS_AGARKONTROLL ? "WHEN b.agarkontroll IN ('stat', 'kommun', 'region') THEN b.agarkontroll" : ''}
    WHEN b.jurform IN ('Bostadsrättsförening', 'Bostadsförening', 'Kooperativ hyresrättsförening') THEN 'brf'
    WHEN b.sni LIKE '68%' THEN 'fastighetsbolag'
    ELSE 'ovriga' END`;
const AGARKATEGORIER = [['stat', 'Staten'], ['kommun', 'Kommun'], ['region', 'Region (landsting)'],
  ['fastighetsbolag', 'Fastighetsbolag'], ['brf', 'Bostadsrättsförening'], ['ovriga', 'Övriga bolag och organisationer']];
const ettAv = (lista) => (v) => (lista.some(([k]) => k === v) ? v : NaN);

// Kartfiltren i /api/fastigheter: [parameter, omvandling till databasens värde, villkor på raden v med ett ?].
// Ogiltiga värden (NaN) och tomma fält stänger av filtret. Villkor och parametrar byggs ur samma lista.
const ar4 = (v) => (/^\d{4}$/.test(v) ? v : NaN);
// Tal som besökaren skriver dem: decimalkomma och mellanslag mellan tusental ("1 000,5").
const tal = (v) => +v.replace(/\s/g, '').replace(',', '.');
const FILTER = [
  ['anv', (v) => v, harTyp('v')],
  ['jur', (v) => v, 'EXISTS (SELECT 1 FROM agande a JOIN bolag b ON b.orgnr = a.orgnr WHERE a.beteckning = v.beteckning AND b.jurform = ?)'],
  ['vmin', (v) => tal(v) * 1000, 'v.varde_tkr >= ?'],   // Mkr -> tkr
  ['vmax', (v) => tal(v) * 1000, 'v.varde_tkr <= ?'],
  ['kmin', (v) => tal(v) * 1e6, 'v.kop_kr >= ?'],       // Mkr -> kr
  ['kar', ar4, 'v.kop_dag >= ?'],                    // köpt år v eller senare (jämförs med ÅÅÅÅ-MM-DD)
  ['ktill', ar4, 'substr(v.kop_dag, 1, 4) <= ?'],   // köpt år v eller tidigare
  ['amin', tal, 'v.areal_m2 >= ?'],           // tomtyta, m²
  ['amax', tal, 'v.areal_m2 <= ?'],
  ['rf', ettAv(UPPLATELSEFORMER), 'v.upplatelse = ?'],
  ['kommun', (v) => v, 'v.kommun = ?'],
  ['lan', (v) => (LAN[v] ? JSON.stringify(KOMMUNER.filter((k) => LAN_FOR_KOMMUN.get(k) === v)) : NaN),   // länskod
    'v.kommun IN (SELECT value FROM json_each(?))'],
  ['agare', (v) => JSON.stringify(normOrgnr(v) ? [normOrgnr(v)] : agareMed(v).map((b) => b.orgnr)),   // namn eller org.nr
    'EXISTS (SELECT 1 FROM agande a WHERE a.beteckning = v.beteckning AND a.orgnr IN (SELECT value FROM json_each(?)))'],
  ['agkat', ettAv(AGARKATEGORIER),
    `EXISTS (SELECT 1 FROM agande a JOIN bolag b ON b.orgnr = a.orgnr WHERE a.beteckning = v.beteckning AND ${AGARKATEGORI_SQL} = ?)`],
  // Uppskattad LOA och lokaltyp finns bara med arbetsställen (SCB).
  ...(HAS_AE ? [
    ['loamin', tal, 'v.loa_m2 >= ?'],
    ['loamax', tal, 'v.loa_m2 <= ?'],
    ['lok', (v) => v, 'EXISTS (SELECT 1 FROM arbetsstalle a WHERE a.beteckning = v.beteckning AND a.lokaltyp = ?)'],
  ] : []),
];
// Varje filter blir "? IS NULL OR villkor": värdet skickas två gånger, null = av.
const filterParams = (url) => FILTER.flatMap(([k, f]) => {
  const raw = url.searchParams.get(k)?.trim();
  const v = raw ? f(raw) : null;
  return Number.isNaN(v) ? [null, null] : [v, v];
});

// Totalt minus exempeldata: count(*) utan filter går på det lilla primärindexet och
// demo = 1 på det partiella indexet, i stället för att läsa alla 2,2 miljoner bolagsrader.
const countReal = (t) => `(SELECT count(*) FROM ${t}) - (SELECT count(*) FROM ${t} WHERE demo = 1)`;
const counts = db.prepare(`SELECT ${countReal('bolag')} AS bolag, ${countReal('fastighet')} AS fastigheter,
  ${countReal('taxering')} AS taxeringar, ${countReal('agande')} AS agande,
  (SELECT count(*) FROM transaktion WHERE demo = 0 AND forvarvare_orgnr IS NOT NULL) AS transaktioner, (SELECT count(*) FROM fastighet WHERE demo = 1) AS demo`);

// Fastigheter i en bbox med kartfiltren (se FILTER): med geometri för kartan, annars bara
// mittpunkten (bboxens mitt) för prickarna vid låg zoom.
const inBboxSql = (geometri, limit) => `
    SELECT * FROM (SELECT f.beteckning, f.kommun,
      ${geometri ? 'f.geojson' : '(f.minx + f.maxx) / 2 AS lon, (f.miny + f.maxy) / 2 AS lat'},
      f.demo, f.areal_m2, ${SENASTE_VARDE} AS varde_tkr,
      (SELECT b.namn FROM agande a JOIN bolag b ON b.orgnr = a.orgnr
         WHERE a.beteckning = f.beteckning LIMIT 1) AS agare,
      -- Senaste köp = senaste överlåtelse med köpeskilling (en gåva utan pris räknas inte), som i panelen.
      (SELECT kopeskilling_kr FROM transaktion x WHERE x.beteckning = f.beteckning AND x.kopeskilling_kr IS NOT NULL AND x.forvarvare_orgnr IS NOT NULL
         ORDER BY inskrivningsdag DESC LIMIT 1) AS kop_kr,
      (SELECT max(inskrivningsdag) FROM transaktion x WHERE x.beteckning = f.beteckning AND x.kopeskilling_kr IS NOT NULL AND x.forvarvare_orgnr IS NOT NULL) AS kop_dag,
      ${SENASTE_TYP} AS typ, ${FASTIGHET_LOA} AS loa_m2, ${UPPLATELSE} AS upplatelse,
      (SELECT b.jurform FROM agande a JOIN bolag b ON b.orgnr = a.orgnr
         WHERE a.beteckning = f.beteckning LIMIT 1) AS agartyp
    FROM fastighet f
    WHERE ${overlapar('fastighet', 'f')}
      AND (? IS NULL OR f.beteckning IN (SELECT beteckning FROM agande WHERE orgnr = ?))) v
    WHERE 1 ${FILTER.map(([, , villkor]) => `AND (? IS NULL OR ${villkor})`).join('\n      ')}
    LIMIT ${limit}`;

// Bolagets fastigheter: lagfaren ägare eller ägare i taxeringen (parametrar: orgnr, orgnr).
const BOLAGETS = `f.beteckning IN (SELECT beteckning FROM agande WHERE orgnr = ?
  UNION SELECT beteckning FROM taxering WHERE agare_orgnr = ?)`;
const BOLAG_LISTA = 500;   // fastigheter i bolagspanelens lista

const exportSql = (geometri) => `
    SELECT f.beteckning, f.kommun, f.areal_m2, ${geometri ? 'f.geojson,' : ''}
      (SELECT group_concat(a.orgnr, '|') FROM agande a WHERE a.beteckning = f.beteckning) AS agare_orgnr,
      (SELECT group_concat(coalesce(b.namn, ''), '|') FROM agande a LEFT JOIN bolag b ON b.orgnr = a.orgnr
         WHERE a.beteckning = f.beteckning) AS agare_namn,
      (SELECT max(ar) FROM taxering WHERE beteckning = f.beteckning) AS taxeringsar,
      ${SENASTE_VARDE} AS taxeringsvarde_tkr,
      (SELECT inskrivningsdag FROM transaktion x WHERE x.beteckning = f.beteckning AND x.forvarvare_orgnr IS NOT NULL
         ORDER BY inskrivningsdag DESC LIMIT 1) AS senaste_overlatelse,
      (SELECT kopeskilling_kr FROM transaktion x WHERE x.beteckning = f.beteckning AND x.forvarvare_orgnr IS NOT NULL
         ORDER BY inskrivningsdag DESC LIMIT 1) AS senaste_kopeskilling_kr
    FROM fastighet f WHERE f.demo = 0 ORDER BY f.beteckning`;

const q = {
  inBbox: db.prepare(inBboxSql(true, MAX_FEATURES + 1)),
  punkter: db.prepare(inBboxSql(false, MAX_PUNKTER + 1)),
  traffCsv: db.prepare(inBboxSql(false, MAX_FEATURES + 1)),
  // Översikt under prickarnas zoom: antal per kommun i hela landet, placerat i fastigheternas medelpunkt.
  kommunKluster: db.prepare(`SELECT kommun, count(*) AS n, sum(varde_tkr) AS varde_tkr,
      round(avg(lon), 4) AS lon, round(avg(lat), 4) AS lat
    FROM (${inBboxSql(false, -1)}) WHERE kommun IS NOT NULL GROUP BY kommun`),
  typer: db.prepare('SELECT DISTINCT typ FROM taxering WHERE typ IS NOT NULL ORDER BY typ'),
  agartyper: db.prepare(`SELECT DISTINCT b.jurform FROM agande a JOIN bolag b ON b.orgnr = a.orgnr
    WHERE b.jurform IS NOT NULL ORDER BY b.jurform`),
  kommuner: db.prepare('SELECT DISTINCT kommun FROM fastighet WHERE kommun IS NOT NULL ORDER BY kommun'),
  planerIBbox: HAS_PLAN && db.prepare(`SELECT p.id, p.typ, p.planid, p.namn, p.datum, p.geojson, p.demo FROM plan p
    WHERE ${overlapar('plan', 'p')} ORDER BY p.datum DESC NULLS LAST LIMIT ${MAX_FEATURES + 1}`),
  fastighet: db.prepare('SELECT beteckning, kommun, areal_m2, kalla, demo, minx, miny, maxx, maxy FROM fastighet WHERE beteckning = ?'),
  taxering: db.prepare(`SELECT t.beteckning, t.taxeringsenhet, t.typ, t.ar, t.agare_orgnr, t.andel, t.demo,
    ${['varde_tkr', 'markvarde_tkr', 'byggvarde_tkr'].map((c) => `CASE WHEN row_number() OVER (PARTITION BY t.ar, coalesce(t.taxeringsenhet, t.rowid) ORDER BY t.varde_tkr DESC, t.rowid) = 1 THEN t.${c} END AS ${c}`).join(', ')},
    b.namn AS agare_namn FROM taxering t
    LEFT JOIN bolag b ON b.orgnr = t.agare_orgnr
    WHERE t.beteckning = ? ORDER BY t.ar DESC`),
  // Tomträttshavaren först: det är den som har fastigheten i sin verksamhet.
  agare: db.prepare(`SELECT a.orgnr, a.andel, a.inskrivningsdag, ${HAS_TOMTRATT ? 'a.tomtratt' : 'NULL AS tomtratt'}, b.namn, b.jurform, b.demo
    FROM agande a LEFT JOIN bolag b ON b.orgnr = a.orgnr WHERE a.beteckning = ? ORDER BY tomtratt DESC`),
  upplatelse: db.prepare(`SELECT ${UPPLATELSE} AS u FROM fastighet f WHERE f.beteckning = ?`),
  // i_affar: antal fastigheter i samma affär (se AFFAR); > 1 är en paketaffär.
  transaktioner: db.prepare(`SELECT x.*, b.namn AS forvarvare_namn,
      (SELECT count(*) FROM transaktion y WHERE y.forvarvare_orgnr = x.forvarvare_orgnr
         AND y.inskrivningsdag = x.inskrivningsdag AND y.kopeskilling_kr = x.kopeskilling_kr) AS i_affar
    FROM transaktion x
    LEFT JOIN bolag b ON b.orgnr = x.forvarvare_orgnr
    WHERE x.beteckning = ? ORDER BY x.inskrivningsdag DESC`),
  bolag: db.prepare('SELECT * FROM bolag WHERE orgnr = ?'),
  // Företag med arbetsställe på fastigheten, störst först.
  hyresgaster: HAS_AE && db.prepare(`SELECT a.orgnr, b.namn, a.benamning, a.sni, a.bransch, a.anstkl,
      a.adress, a.reklamsparr, a.demo
    FROM arbetsstalle a LEFT JOIN bolag b ON b.orgnr = a.orgnr WHERE a.beteckning = ?
    ORDER BY a.anstkl DESC NULLS LAST, coalesce(b.namn, a.benamning) LIMIT 300`),
  // Uppskattad användning per lokaltyp (se LOKALTYPER), störst först.
  anvandning: HAS_AE && db.prepare(`SELECT lokaltyp AS typ, sum(loa_m2) AS loa_m2
    FROM arbetsstalle WHERE beteckning = ? GROUP BY lokaltyp ORDER BY loa_m2 DESC`),
  // Bolagets arbetsställen på fastigheter i Horos.
  arbetsstallen: HAS_AE && db.prepare(`SELECT a.benamning, a.bransch, a.anstkl, a.adress, a.reklamsparr, a.beteckning,
      f.minx, f.miny, f.maxx, f.maxy
    FROM arbetsstalle a JOIN fastighet f ON f.beteckning = a.beteckning WHERE a.orgnr = ?
    ORDER BY a.anstkl DESC NULLS LAST, a.adress LIMIT 100`),
  // Bolagets köp; en paketaffär (se AFFAR) blir en rad med antal fastigheter.
  bolagKop: db.prepare(`SELECT x.inskrivningsdag AS dag, x.kopeskilling_kr AS kr, min(x.beteckning) AS beteckning,
      count(*) AS antal, f.minx, f.miny, f.maxx, f.maxy
    FROM transaktion x JOIN fastighet f ON f.beteckning = x.beteckning
    WHERE x.forvarvare_orgnr = ? GROUP BY x.inskrivningsdag, x.kopeskilling_kr ORDER BY dag DESC LIMIT 50`),
  // Sålt: bolagets förvärv som följs av en överlåtelse till någon annan (nästa förvärv av fastigheten).
  // GROUP BY: köp eller försäljning i flera andelar samma dag blir en rad.
  bolagSalt: db.prepare(`SELECT x.beteckning, x.inskrivningsdag AS kopt, max(x.kopeskilling_kr) AS kop_kr,
      y.inskrivningsdag AS salt, max(y.kopeskilling_kr) AS salt_kr, y.forvarvare_orgnr AS kopare_orgnr, b.namn AS kopare,
      f.minx, f.miny, f.maxx, f.maxy
    FROM transaktion x
    JOIN transaktion y ON y.beteckning = x.beteckning AND y.inskrivningsdag = (SELECT min(z.inskrivningsdag)
      FROM transaktion z WHERE z.beteckning = x.beteckning AND z.inskrivningsdag > x.inskrivningsdag)
    JOIN fastighet f ON f.beteckning = x.beteckning LEFT JOIN bolag b ON b.orgnr = y.forvarvare_orgnr
    WHERE x.forvarvare_orgnr = ? AND y.forvarvare_orgnr IS NOT NULL AND y.forvarvare_orgnr IS NOT x.forvarvare_orgnr
    GROUP BY x.beteckning, x.inskrivningsdag, y.inskrivningsdag ORDER BY y.inskrivningsdag DESC LIMIT 50`),
  bolagFastigheter: db.prepare(`
    SELECT f.beteckning, f.areal_m2, f.minx, f.miny, f.maxx, f.maxy, ${SENASTE_VARDE} AS varde_tkr
    FROM fastighet f WHERE ${BOLAGETS}
    ORDER BY varde_tkr DESC NULLS LAST LIMIT ${BOLAG_LISTA}`),
  // Summor över alla bolagets fastigheter (listan ovan är kapad), och alla beteckningar för inramningen.
  bolagSumma: db.prepare(`SELECT count(*) AS antal, sum(f.areal_m2) AS areal_m2, sum(${SENASTE_VARDE}) AS varde_tkr,
      min(f.minx) AS minx, min(f.miny) AS miny, max(f.maxx) AS maxx, max(f.maxy) AS maxy,
      json_group_array(f.beteckning) AS beteckningar
    FROM fastighet f WHERE ${BOLAGETS}`),
  // Fulltext via bolag_fts (byggs av import:bolag, build-public och demo-data).
  sokBolag: HAS_FTS
    ? db.prepare(`SELECT b.orgnr, b.namn, b.postort, b.demo, b.avregistrerad
        FROM bolag_fts JOIN bolag b ON b.rowid = bolag_fts.rowid WHERE bolag_fts MATCH ? LIMIT 300`)
    : db.prepare('SELECT orgnr, namn, postort, demo, avregistrerad FROM bolag WHERE namn LIKE ? LIMIT 300'),
  agareLista: db.prepare(`SELECT b.orgnr, b.namn, b.postort, b.demo, b.avregistrerad, count(DISTINCT a.beteckning) AS n
    FROM agande a JOIN bolag b ON b.orgnr = a.orgnr GROUP BY b.orgnr`),
  sokFastighet: db.prepare(`SELECT f.beteckning, f.minx, f.miny, f.maxx, f.maxy FROM fastighet_fts
    JOIN fastighet f ON f.rowid = fastighet_fts.rowid WHERE fastighet_fts MATCH ? LIMIT 10`),
  sokAdress: HAS_ADRESS && db.prepare(`SELECT a.gata, a.nummer, a.postnr, a.ort, a.lon, a.lat
    FROM adress_fts JOIN adress a ON a.id = adress_fts.rowid WHERE adress_fts MATCH ? LIMIT 200`),
  fastighetVidPunkt: db.prepare(`SELECT f.beteckning, f.geojson FROM fastighet f
    WHERE ${overlapar('fastighet', 'f')} LIMIT 100`),
  adresserIBbox: HAS_ADRESS && db.prepare(`SELECT gata, nummer, lon, lat FROM adress
    WHERE lon BETWEEN ? AND ? AND lat BETWEEN ? AND ? LIMIT 2000`),
  fororenatNara: HAS_FORORENAT && db.prepare(`SELECT ebh_id, bransch, bransch2, status, riskklass, lon, lat FROM fororenat
    WHERE lon BETWEEN ? AND ? AND lat BETWEEN ? AND ? LIMIT 500`),
  fastighetGeom: db.prepare('SELECT geojson, minx, miny, maxx, maxy FROM fastighet WHERE beteckning = ?'),
  // Underlag för scenarierna: fastigheterna i listan (JSON) med värde, typ, upplåtelseform och uppskattad LOA.
  underlag: db.prepare(`SELECT f.beteckning, f.kommun, f.areal_m2, f.demo, f.minx, f.miny, f.maxx, f.maxy,
      ${SENASTE_VARDE} AS varde_tkr, ${SENASTE_TYP} AS typ, ${UPPLATELSE} AS upplatelse
    FROM fastighet f WHERE f.beteckning IN (SELECT value FROM json_each(?))`),
  underlagLoa: HAS_AE && db.prepare(`SELECT beteckning, lokaltyp, sum(loa_m2) AS m2 FROM arbetsstalle
    WHERE beteckning IN (SELECT value FROM json_each(?)) GROUP BY beteckning, lokaltyp`),
  // En rad per granne med (första) ägaren.
  grannar: db.prepare(`SELECT f.beteckning, f.minx, f.miny, f.maxx, f.maxy, min(a.orgnr) AS orgnr, b.namn AS agare, b.demo
    FROM fastighet f LEFT JOIN agande a ON a.beteckning = f.beteckning LEFT JOIN bolag b ON b.orgnr = a.orgnr
    WHERE ${overlapar('fastighet', 'f')} AND f.beteckning != ? GROUP BY f.beteckning LIMIT 30`),
  narKop: db.prepare(`SELECT x.inskrivningsdag AS dag, x.kopeskilling_kr AS kr, x.forvarvare_orgnr AS orgnr, x.andel,
      b.namn, b.demo, f.beteckning, f.areal_m2, f.minx, f.miny, f.maxx, f.maxy
    FROM fastighet f JOIN transaktion x ON x.beteckning = f.beteckning LEFT JOIN bolag b ON b.orgnr = x.forvarvare_orgnr
    WHERE ${overlapar('fastighet', 'f')} AND f.beteckning != ? AND x.kopeskilling_kr IS NOT NULL AND x.forvarvare_orgnr IS NOT NULL
    ORDER BY x.inskrivningsdag DESC LIMIT 40`),
  export: db.prepare(exportSql(true)),
  exportCsv: db.prepare(exportSql(false)),
};

// I publikt läge är databasen skrivskyddad och byts bara ut med en omstart: räkna en gång.
const statusCounts = PUBLIC_MODE ? counts.get() : null;
// Användningarna i filtret. shortcut: läses vid start, så en lokal import syns först efter omstart.
const TYPER = q.typer.all().map((r) => r.typ);
const AGARTYPER = q.agartyper.all().map((r) => r.jurform);
const KOMMUNER = q.kommuner.all().map((r) => r.kommun);
const KOMMUN_BBOX = db.prepare(`SELECT kommun AS namn, min(minx) AS minx, min(miny) AS miny, max(maxx) AS maxx, max(maxy) AS maxy
  FROM fastighet WHERE kommun IS NOT NULL GROUP BY kommun ORDER BY kommun`).all()
  .map((k) => ({ ...k, lan: LAN_FOR_KOMMUN.get(k.namn) ?? null }));

// Kommunklustren läser hela landet; datan ändras bara med en omstart (som TYPER), så svaren sparas per filter.
// shortcut: ett nytt filter räknas om över alla fastigheter vid första anropet; förberäkna i build-public om det blir långsamt.
const klusterCache = new Map();

// Fastigheterna i kartutsnittet (bbox) med filtren, eller null om bbox saknas.
function traffar(url, stmt = q.inBbox) {
  const bbox = (url.searchParams.get('bbox') ?? '').split(',').map(Number);
  if (bbox.length !== 4 || bbox.some(Number.isNaN)) return null;
  const [minx, miny, maxx, maxy] = bbox;
  const org = normOrgnr(url.searchParams.get('org') ?? '') || null;   // bara ett bolags fastigheter
  return stmt.all(minx, maxx, miny, maxy, org, org, ...filterParams(url));
}
// Kolumnerna i träff-exporten (utan geometri, se EXPORT_GEOMETRI).
const TRAFF_COLS = ['beteckning', 'agare', 'agartyp', 'typ', 'varde_tkr', 'areal_m2', 'loa_m2', 'upplatelse', 'kop_dag', 'kop_kr'];

// --- Affärer och största ägare -------------------------------------------------
// En affär = överlåtelser med samma dag, köpeskilling och förvärvare: vid en paketaffär står
// hela köpeskillingen på varje fastighet och skulle annars räknas flera gånger.
// shortcut: två olika affärer med exakt samma dag, pris och köpare slås ihop; byt till
// Lantmäteriets förvärvs-id när det finns i filen.
const AFFAR = `WITH affar AS (
  SELECT x.inskrivningsdag AS dag, x.kopeskilling_kr AS kr, x.forvarvare_orgnr AS orgnr,
    min(x.beteckning) AS beteckning, count(*) AS antal, max(x.demo) AS demo
  FROM transaktion x JOIN fastighet f ON f.beteckning = x.beteckning
  WHERE x.forvarvare_orgnr IS NOT NULL AND x.kopeskilling_kr >= ? AND (? IS NULL OR f.kommun = ?)
  GROUP BY 1, 2, 3)`;
// Säljaren = förvärvaren i fastighetens föregående överlåtelse (om den finns).
const AFFAR_RAD = `SELECT a.dag, a.kr, a.orgnr, a.beteckning, a.antal, a.demo, b.namn, f.kommun,
    f.minx, f.miny, f.maxx, f.maxy, sb.orgnr AS saljare_orgnr, sb.namn AS saljare
  FROM affar a
  LEFT JOIN bolag sb ON sb.orgnr = (SELECT p.forvarvare_orgnr FROM transaktion p
    WHERE p.beteckning = a.beteckning AND p.inskrivningsdag < a.dag ORDER BY p.inskrivningsdag DESC LIMIT 1)
  JOIN fastighet f ON f.beteckning = a.beteckning LEFT JOIN bolag b ON b.orgnr = a.orgnr`;
// Affärer i pressmeddelanden, senaste först, med fastigheterna som finns i Horos (eller adresspunkten)
// som bbox och beteckningar för kartan.
// aktor_orgnr saknas i publika databaser byggda före kolumnen (lib/db.mjs).
const NYHET_KOLUMNER = 'n.url, n.kalla, n.utgivare, n.rubrik, substr(n.datum, 1, 10) AS dag, n.typ, n.pris_kr, n.kommun'
  + (hasColumn(db, 'nyhet', 'aktor_orgnr') ? ', n.aktor_orgnr' : '');
const nyhetsBolag = db.prepare('SELECT orgnr, namn FROM bolag WHERE namn = ?');
const aktorsBolag = db.prepare('SELECT orgnr, namn FROM bolag WHERE orgnr = ?');
const PRESSMEDDELANDE = "('cision', 'mfn')";   // övriga källor är tidningar: källan, inte köparen eller säljaren
const publikNyhet = ({ aktor_orgnr, ...n }) => {
  const b = PRESSMEDDELANDE.includes(`'${n.kalla}'`) ? nyhetsBolag.get(n.utgivare) : aktor_orgnr ? aktorsBolag.get(aktor_orgnr) : null;
  return { ...n, rubrik: nyhetsRubrik(n, normOrgnr(b?.orgnr) ? b.namn : null) };
};
// Samma affär i flera källor (samma typ och pris, högst 3 dagar isär, inte olika kända kommuner) visas en gång:
// pressmeddelandet, som är förstahandskällan och namnger bolaget, annars tidningen som var först. Utan pris går det
// inte att avgöra. Datumintervallet som text (ISO, som datum sparas) så att indexet nyhet_affar används; `extra`
// begränsar vilka nyheter som får ersätta (i fastighetspanelen bara de som visas där).
const ISO = "'%Y-%m-%dT%H:%M:%fZ'";
const inteDubblett = (extra = '') => `NOT (n.kalla NOT IN ${PRESSMEDDELANDE} AND EXISTS (SELECT 1 FROM nyhet d
  WHERE d.typ = n.typ AND d.pris_kr = n.pris_kr
    AND d.datum BETWEEN strftime(${ISO}, n.datum, '-3 days') AND strftime(${ISO}, n.datum, '+3 days')
    AND d.url != n.url AND (d.kommun IS NULL OR n.kommun IS NULL OR d.kommun = n.kommun) ${extra}
    AND (d.kalla IN ${PRESSMEDDELANDE} OR d.datum < n.datum OR (d.datum = n.datum AND d.url < n.url))))`;
const qn = HAS_NYHET && {
  senaste: db.prepare(`SELECT ${NYHET_KOLUMNER},
      min(coalesce(f.minx, p.lon)) AS minx, min(coalesce(f.miny, p.lat)) AS miny,
      max(coalesce(f.maxx, p.lon)) AS maxx, max(coalesce(f.maxy, p.lat)) AS maxy,
      json_group_array(f.beteckning) FILTER (WHERE f.beteckning IS NOT NULL) AS beteckningar
    FROM nyhet n LEFT JOIN nyhet_plats p ON p.url = n.url LEFT JOIN fastighet f ON f.beteckning = p.beteckning
    WHERE (? IS NULL OR n.kommun = ?) AND ${inteDubblett()} GROUP BY n.url ORDER BY n.datum DESC LIMIT 30`),
  fastighet: db.prepare(`SELECT ${NYHET_KOLUMNER} FROM nyhet n
    WHERE n.url IN (SELECT url FROM nyhet_plats WHERE beteckning = ?)
      AND ${inteDubblett('AND d.url IN (SELECT url FROM nyhet_plats WHERE beteckning = ?)')} ORDER BY n.datum DESC`),
};

const qa = {
  ar:db.prepare(`${AFFAR} SELECT DISTINCT substr(dag, 1, 4) AS ar FROM affar WHERE dag IS NOT NULL ORDER BY ar DESC`),
  summa: db.prepare(`${AFFAR} SELECT count(*) AS antal, sum(kr) AS kr FROM affar WHERE substr(dag, 1, 4) = ?`),
  dagar30: db.prepare(`${AFFAR} SELECT count(*) AS antal, sum(kr) AS kr FROM affar WHERE dag >= date('now', '-30 days')`),
  senaste: db.prepare(`${AFFAR} ${AFFAR_RAD} WHERE substr(a.dag, 1, 4) = ? ORDER BY a.dag DESC LIMIT 25`),
  storsta: db.prepare(`${AFFAR} ${AFFAR_RAD} WHERE substr(a.dag, 1, 4) = ? ORDER BY a.kr DESC LIMIT 5`),
  perTyp: db.prepare(`${AFFAR} SELECT ${SENASTE_TYP} AS typ, count(*) AS antal, sum(a.kr) AS kr
    FROM affar a JOIN fastighet f ON f.beteckning = a.beteckning WHERE substr(a.dag, 1, 4) = ? GROUP BY 1`),
  perKommun: db.prepare(`${AFFAR} SELECT f.kommun, count(*) AS antal, sum(a.kr) AS kr
    FROM affar a JOIN fastighet f ON f.beteckning = a.beteckning WHERE substr(a.dag, 1, 4) = ?
    GROUP BY f.kommun ORDER BY kr DESC LIMIT 15`),
  kopare: db.prepare(`${AFFAR} SELECT a.orgnr, b.namn, max(a.demo) AS demo, count(*) AS antal, sum(a.kr) AS kr
    FROM affar a LEFT JOIN bolag b ON b.orgnr = a.orgnr WHERE substr(a.dag, 1, 4) = ? AND a.orgnr IS NOT NULL
    GROUP BY a.orgnr ORDER BY kr DESC LIMIT 10`),
};
const AFFAR_MIN = [0, 10, 40, 100];   // Mkr; fasta val så att cachen inte kan växa obegränsat
const STORST_EFTER = { antal: 'antal', areal: 'areal_m2', varde: 'varde_tkr' };
// [kommun|bbox][efter]: med bbox avgränsas urvalet till kartutsnittet i stället för kommunen.
const storstaSql = (bbox, col) => db.prepare(`
  SELECT a.orgnr, b.namn, b.jurform, max(b.demo) AS demo, count(*) AS antal,
    sum(f.areal_m2) AS areal_m2, sum(${SENASTE_VARDE}) AS varde_tkr
  FROM agande a JOIN fastighet f ON f.beteckning = a.beteckning LEFT JOIN bolag b ON b.orgnr = a.orgnr
  WHERE ${bbox ? overlapar('fastighet', 'f') : '(? IS NULL OR f.kommun = ?)'} AND (? IS NULL OR ${harTyp('f')})
  GROUP BY a.orgnr ORDER BY ${col} DESC NULLS LAST LIMIT 25`);
const storstaAgare = Object.fromEntries([false, true].map((bbox) => [bbox ? 'bbox' : 'kommun',
  Object.fromEntries(Object.entries(STORST_EFTER).map(([k, col]) => [k, storstaSql(bbox, col)]))]));

// I publikt läge ändras databasen inte: svaren cachas (nycklarna är begränsade av valideringen).
// Töms vid dygnsskiftet, eftersom affärerna räknar "senaste 30 dagarna" från dagens datum.
const cache = new Map();
let cacheDag = '';
const cached = (key, fn) => {
  if (!PUBLIC_MODE) return fn();
  const idag = new Date().toISOString().slice(0, 10);
  if (idag !== cacheDag) { cache.clear(); cacheDag = idag; }
  if (!cache.has(key)) cache.set(key, fn());
  return cache.get(key);
};
const oneOf = (v, list) => (v && list.includes(v) ? v : null);

function affarer(url) {
  const kommun = oneOf(url.searchParams.get('kommun'), KOMMUNER);
  const minMkr = AFFAR_MIN.includes(Number(url.searchParams.get('min'))) ? Number(url.searchParams.get('min')) : 0;
  const p = [minMkr * 1e6, kommun, kommun];
  const arLista = cached(`affarAr|${kommun}|${minMkr}`, () => qa.ar.all(...p).map((r) => r.ar));
  const ar = oneOf(url.searchParams.get('ar'), arLista) ?? arLista[0] ?? null;
  // Org.nr skrivs med eller utan bindestreck; i databasen står det utan.
  const sok = (url.searchParams.get('sok') ?? '').toLocaleLowerCase('sv').replace(/\b(\d{6})-(\d{4})\b/g, '$1$2')
    .split(/\s+/).filter(Boolean).join(' ').slice(0, 60);
  const oversikt = cached(`affarer|${kommun}|${minMkr}|${ar}`, () => {
    return {
      kommun, min: minMkr, ar, arLista,
      summa: ar ? qa.summa.get(...p, ar) : { antal: 0, kr: null },
      dagar30: qa.dagar30.get(...p),
      senaste: ar ? qa.senaste.all(...p, ar) : [],
      storsta: ar ? qa.storsta.all(...p, ar) : [],
      perTyp: ar ? qa.perTyp.all(...p, ar) : [],
      kopare: ar ? qa.kopare.all(...p, ar) : [],
      perKommun: ar && !kommun ? qa.perKommun.all(...p, ar) : [],
      nyheter: qn ? qn.senaste.all(kommun, kommun).map((n) => ({ ...publikNyhet(n), beteckningar: JSON.parse(n.beteckningar) })) : [],
    };
  });
  return sok.length >= 2 ? { ...oversikt, sok, traffar: sokAffarer(sok, minMkr * 1e6, kommun) } : oversikt;
}

// Sökningen i Transaktioner: alla affärer i minnet, senaste först, med en söktext (alla fastigheter i paketet,
// köparen och varje fastighets säljare, namn och org.nr) och kommunerna paketet berör. Samma affär och säljare
// som AFFAR/AFFAR_RAD, men hela paketet grupperas före kommunfiltret. Byggs vid start i publikt läge
// (databasen ändras inte), annars vid varje sökning. shortcut: linjär sökning i minnet (600 000 affärer:
// ~100 ms per sökning); byt mot FTS i build-public om den blir långsam med rikstäckande lagfarter.
const affarSokRader = db.prepare(`SELECT x.inskrivningsdag AS dag, x.kopeskilling_kr AS kr, x.forvarvare_orgnr AS orgnr,
    x.beteckning, x.demo, b.namn, f.kommun, sb.orgnr AS saljare_orgnr, sb.namn AS saljare
  FROM transaktion x JOIN fastighet f ON f.beteckning = x.beteckning LEFT JOIN bolag b ON b.orgnr = x.forvarvare_orgnr
  LEFT JOIN bolag sb ON sb.orgnr = (SELECT p.forvarvare_orgnr FROM transaktion p
    WHERE p.beteckning = x.beteckning AND p.inskrivningsdag < x.inskrivningsdag ORDER BY p.inskrivningsdag DESC LIMIT 1)
  WHERE x.forvarvare_orgnr IS NOT NULL AND x.kopeskilling_kr IS NOT NULL
  ORDER BY x.inskrivningsdag DESC, x.kopeskilling_kr, x.forvarvare_orgnr, x.beteckning`);
// Visningsuppgifterna (som AFFAR_RAD) hämtas bara för träffarna, så att listan i minnet hålls liten.
const affarSokDetalj = db.prepare(`SELECT b.namn, f.kommun, f.minx, f.miny, f.maxx, f.maxy, sb.orgnr AS saljare_orgnr, sb.namn AS saljare
  FROM fastighet f LEFT JOIN bolag b ON b.orgnr = ?
  LEFT JOIN bolag sb ON sb.orgnr = (SELECT p.forvarvare_orgnr FROM transaktion p
    WHERE p.beteckning = f.beteckning AND p.inskrivningsdag < ? ORDER BY p.inskrivningsdag DESC LIMIT 1)
  WHERE f.beteckning = ?`);
function byggAffarSok() {
  const lista = [];
  let a = null;
  const klar = (x) => { x.text = x.text.filter(Boolean).join(' ').toLocaleLowerCase('sv'); x.kommuner = `|${[...new Set(x.kommuner)].join('|')}|`; };
  for (const r of affarSokRader.iterate()) {
    // Första raden i affären har den minsta beteckningen: den och dess säljare visas, som i AFFAR_RAD.
    if (!a || r.dag !== a.dag || r.kr !== a.kr || r.orgnr !== a.orgnr) {
      if (a) klar(a);
      a = { dag: r.dag, kr: r.kr, orgnr: r.orgnr, beteckning: r.beteckning, antal: 0, demo: r.demo, text: [r.orgnr, r.namn], kommuner: [] };
      lista.push(a);
    }
    a.antal++;
    a.demo ||= r.demo;
    a.text.push(r.beteckning, r.saljare_orgnr, r.saljare);
    a.kommuner.push(r.kommun);
  }
  if (a) klar(a);
  return lista;
}
let AFFAR_SOK = null;
const affarSok = () => (PUBLIC_MODE ? (AFFAR_SOK ??= byggAffarSok()) : byggAffarSok());
// Byggs efter listen: anrop under bygget (600 000 affärer ~15 s, ~200 MB) väntar i kön i stället för att nekas.
if (PUBLIC_MODE) setImmediate(affarSok);
// Alla ord ska finnas (versaler och å/ä/ö spelar ingen roll, som agareMed); högst 50 träffar.
function sokAffarer(sok, minKr, kommun) {
  const ord = sok.split(' ');
  const traffar = [];
  for (const a of affarSok()) {
    if (a.kr >= minKr && (!kommun || a.kommuner.includes(`|${kommun}|`)) && ord.every((o) => a.text.includes(o))) traffar.push(a);
    if (traffar.length === 50) break;
  }
  return traffar.map(({ dag, kr, orgnr, beteckning, antal, demo }) =>
    ({ dag, kr, orgnr, beteckning, antal, demo, ...affarSokDetalj.get(orgnr, dag, beteckning) }));
}

function storsta(url) {
  const kommun = oneOf(url.searchParams.get('kommun'), KOMMUNER);
  const anv = oneOf(url.searchParams.get('anv'), TYPER);
  const efter = STORST_EFTER[url.searchParams.get('efter')] ? url.searchParams.get('efter') : 'antal';
  const bbox = (url.searchParams.get('bbox') ?? '').split(',').map(Number);
  if (bbox.length === 4 && !bbox.some(Number.isNaN)) {   // kartutsnittet: cachas inte (godtyckliga nycklar)
    const [minx, miny, maxx, maxy] = bbox;
    return { kommun: null, utsnitt: true, anv, efter, agare: storstaAgare.bbox[efter].all(minx, maxx, miny, maxy, anv, anv) };
  }
  return cached(`storsta|${kommun}|${anv}|${efter}`, () => ({
    kommun, anv, efter, agare: storstaAgare.kommun[efter].all(kommun, kommun, anv, anv),
  }));
}

// Metadata från build-public (saknas i utvecklingsdatabasen).
const META = hasTable('meta')
  ? Object.fromEntries(db.prepare('SELECT nyckel, varde FROM meta').all().map((r) => [r.nyckel, r.varde]))
  : {};
// Fastighetsgränserna kommer från Lantmäteriet och får bara delas vidare som fil om beslutet
// tillåter det; slås på med build-public --export-geometri (eller EXPORT_GEOMETRI=1).
const EXPORT_GEOMETRI = META.export_geometri === '1' || process.env.EXPORT_GEOMETRI === '1';

const bolagSumma = (orgnr) => {
  const r = q.bolagSumma.get(orgnr, orgnr);
  return { ...r, beteckningar: JSON.parse(r.beteckningar) };
};

// Fritext -> FTS5-fråga med prefixmatchning per ord: "vasa kron" -> "vasa"* "kron"*
const ftsQuery = (term) => term.split(/\s+/).filter(Boolean).map((w) => `"${w.replace(/"/g, '')}"*`).join(' ');

// Bolag som äger fastigheter, i minnet: de ska inte försvinna bland fulltextsökningens 300 första
// träffar bland 2,2 miljoner bolag. shortcut: läses vid start, som TYPER.
const AGARE = q.agareLista.all().map((b) => ({ ...b, sok: b.namn.toLocaleLowerCase('sv') }));
const ANTAL_AGDA = new Map(AGARE.map((b) => [b.orgnr, b.n]));
const bolagTraff = ({ orgnr, namn, postort, demo }) => ({ orgnr, namn, postort, demo, fastigheter: ANTAL_AGDA.get(orgnr) ?? 0 });
// Ägare vars namn innehåller alla sökta ord (versaler och å/ä/ö spelar ingen roll).
const agareMed = (term) => {
  const ord = term.toLocaleLowerCase('sv').split(/\s+/).filter(Boolean);
  return AGARE.filter((b) => ord.every((o) => b.sok.includes(o)));
};
const sokAgare = (term) => agareMed(term).slice(0, 50);

function sokBolag(term) {
  const fraga = HAS_FTS ? ftsQuery(term) : `%${term}%`;
  const unika = new Map([...q.sokBolag.all(fraga), ...sokAgare(term)].map((b) => [b.orgnr, { ...b, n: ANTAL_AGDA.get(b.orgnr) ?? 0 }]));
  return [...unika.values()]
    // Bolag med fastigheter först, sedan aktiva före avregistrerade, kortare namn (närmare träff) först.
    .sort((x, y) => (y.n > 0) - (x.n > 0) || (x.avregistrerad ? 1 : 0) - (y.avregistrerad ? 1 : 0) || x.namn.length - y.namn.length)
    .slice(0, 15)
    .map(bolagTraff);
}

// Fastigheten som adresspunkten ligger på (bbox-kandidater, sedan punkt-i-polygon).
const fastighetVid = (lon, lat) =>
  q.fastighetVidPunkt.all(lon, lon, lat, lat).find((f) => pointInGeom([lon, lat], JSON.parse(f.geojson)))?.beteckning ?? null;

// Adresserna som ligger på fastigheten, t.ex. ["Drottninggatan 53", "Drottninggatan 55"].
// Planerna som gäller någon del av fastigheten, nyaste först.
// Fastighetens bbox utvidgad med m meter, som [minx, maxx, miny, maxy] för overlapar().
const runt = (f, m) => {
  const dy = m / 111_320, dx = dy / Math.cos(((f.miny + f.maxy) / 2) * Math.PI / 180);
  return [f.minx - dx, f.maxx + dx, f.miny - dy, f.maxy + dy];
};
// shortcut: grannar = bbox inom 10 m, inte delad gräns; byt mot polygontest om listan blir för lång.
const GRANNE_M = 10, NARA_M = 300;
function omgivning(bet) {
  const f = q.fastighetGeom.get(bet);
  if (!f) return { grannar: [], narKop: [] };
  // En paketaffär (se AFFAR) visas en gång och märks, eftersom priset gäller flera fastigheter.
  // shortcut: paketet känns bara igen om flera av dess fastigheter ligger inom NARA_M.
  const key = (x) => `${x.dag}|${x.kr}|${x.orgnr}`;
  const perAffar = new Map();
  for (const x of q.narKop.all(...runt(f, NARA_M), bet)) {
    const a = perAffar.get(key(x));
    if (a) a.paket = true;
    else perAffar.set(key(x), { ...x, paket: false });
  }
  const narKop = [...perAffar.values()].slice(0, 10);
  return { grannar: q.grannar.all(...runt(f, GRANNE_M), bet), narKop };
}

function planerPa(bet) {
  const f = q.planerIBbox && q.fastighetGeom.get(bet);
  if (!f) return [];
  const pts = innerPoints(JSON.parse(f.geojson));
  return q.planerIBbox.all(f.minx, f.maxx, f.miny, f.maxy)
    .filter((p) => { const g = JSON.parse(p.geojson); return pts.some((pt) => pointInGeom(pt, g)); })
    .map(({ geojson, ...p }) => p);
}

// Förorenade områden inom FORORENAT_M från fastighetens gräns (högst riskklass först, oklassade sist) och
// utsatta områden inom UTSATT_M från dess mitt, närmast först. null = datan saknas i databasen.
const FORORENAT_M = 150, UTSATT_M = 5000;
const UTSATTA = HAS_UTSATT ? db.prepare('SELECT id, namn, kategori, ort, polisomrade, datum, geojson FROM utsatt_omrade').all()
  .map(({ geojson, ...u }) => ({ ...u, geom: JSON.parse(geojson) })) : [];
const narmast = (a, b) => a.avstand_m - b.avstand_m;
function miljoRisk(bet) {
  const f = q.fastighetGeom.get(bet);
  if (!f) return { fororenade: null, utsatta: null };
  const geom = JSON.parse(f.geojson);
  const mitt = [(f.minx + f.maxx) / 2, (f.miny + f.maxy) / 2];
  return {
    fororenade: HAS_FORORENAT ? q.fororenatNara.all(...runt(f, FORORENAT_M))
      .map(({ lon, lat, ...r }) => ({ ...r, avstand_m: Math.round(avstandM([lon, lat], geom)) }))
      .filter((r) => r.avstand_m <= FORORENAT_M).sort((a, b) => (a.riskklass ?? 9) - (b.riskklass ?? 9) || narmast(a, b)) : null,
    utsatta: HAS_UTSATT ? UTSATTA.map(({ geom: g, ...u }) => ({ ...u, avstand_m: Math.round(avstandM(mitt, g)) }))
      .filter((u) => u.avstand_m <= UTSATT_M).sort(narmast) : null,
  };
}

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

// Inläsning från fil (scenario.js): en rad med beteckning, adress och kommun -> fastigheten i Horos, eller null med
// orsaken ('kommun' när kommunen saknas eller är okänd, annars 'okand'). Kommunen krävs alltid: samma beteckning
// ("Kungsbron 1") och samma adress finns i flera kommuner. Den tas från kolumnen, från början av beteckningen
// ("Stockholm Kungsbron 1") eller efter ett kommatecken i adressen ("Kungsgatan 12, Stockholm"), och fastighetens
// kommun måste stämma. Bara fastigheter som finns i Horos kan hittas.
function matchaRad(r) {
  const text = (v) => (typeof v === 'string' || typeof v === 'number' ? String(v).trim().slice(0, 200) : '');
  let bet = normBeteckning(text(r?.bet)), kommun = text(r?.kommun) ? kommunAv(text(r.kommun)) : null;
  const [adress, adressKommun] = text(r?.adress).split(',').map((x) => x.trim());
  const forst = bet && kommunForst(bet);
  if (forst) { kommun ??= forst.kommun; bet = forst.resten; }
  kommun ??= adressKommun ? kommunAv(adressKommun) : null;
  if (!kommun) return { beteckning: null, via: null, orsak: 'kommun' };
  const iKommunen = (f) => f && (f.kommun ?? '').toUpperCase() === kommun.toUpperCase();
  if (bet) {
    if (forst && forst.kommun !== kommun) return { beteckning: null, via: null, orsak: 'kommun' };
    const f = q.fastighet.get(fastighetsBet(bet, kommun));
    if (iKommunen(f)) return { beteckning: f.beteckning, via: 'beteckning' };
  }
  if (adress && q.sokAdress && /\p{L}/u.test(adress)) {
    // Alla träffar i adressökningen (sökrutan visar bara 6): samma gata finns i många orter.
    for (const a of q.sokAdress.all(ftsQuery(adress))) {
      if (`${a.gata} ${a.nummer}`.toLowerCase() !== adress.toLowerCase()) continue;
      const b = fastighetVid(a.lon, a.lat);
      if (b && iKommunen(q.fastighet.get(b))) return { beteckning: b, via: 'adress' };
    }
  }
  return { beteckning: null, via: null, orsak: 'okand' };
}

// GeoJSON-feature som sträng: geometrin ligger redan som JSON i databasen och skarvas in
// direkt i stället för att tolkas och serialiseras om för varje fastighet.
const featureJson = (geojson, properties) =>
  `{"type":"Feature","geometry":${geojson},"properties":${JSON.stringify(properties)}}`;

// --- Öppen data: hela den publika datan som CSV (och GeoJSON om tillåtet) -----
const EXPORT_COLS = ['beteckning', 'kommun', 'areal_m2', 'agare_orgnr', 'agare_namn', 'taxeringsar',
  'taxeringsvarde_tkr', 'senaste_overlatelse', 'senaste_kopeskilling_kr'];
const exportCache = new Map();
// BOM + semikolon så att svensk Excel öppnar filen rätt.
const toCsv = (cols, rows) => '﻿' + [cols.join(';'), ...rows.map((r) => cols.map((c) => csvCell(r[c])).join(';'))].join('\r\n');

function buildExport() {
  if (exportCache.has('geojson')) return exportCache.get('geojson');
  const features = q.export.all().map((r) => featureJson(r.geojson, Object.fromEntries(EXPORT_COLS.map((c) => [c, r[c]]))));
  const buf = Buffer.from(`{"type":"FeatureCollection","features":[${features.join(',')}]}`, 'utf8');
  exportCache.set('geojson', buf);
  return buf;
}

function* csvRader(rows) {
  yield '﻿' + EXPORT_COLS.join(';');
  for (const r of rows) yield '\r\n' + EXPORT_COLS.map((c) => csvCell(r[c])).join(';');
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

// Varje rutt: [mönster, hastighetsgräns, hanterare, metod (GET om den saknas)]. Hanteraren returnerar
// [status, body] (skickas som JSON) eller skriver själv till res (kartrutor, nedladdningar).
const routes = [
  [/^\/api\/status$/, 'api', () => [200, {
    ...(statusCounts ?? counts.get()),
    byggd: META.byggd ?? null,
    export: { csv: true, geojson: EXPORT_GEOMETRI },
    typer: TYPER,
    agartyper: AGARTYPER,
    kommuner: KOMMUNER,
    // Län och kommuner med fastigheter, med kommunens utbredning för att kunna zooma dit.
    lan: [...new Set(KOMMUNER.map((k) => LAN_FOR_KOMMUN.get(k)).filter(Boolean))].sort().map((kod) => ({ kod, namn: LAN[kod] })),
    kommunInfo: KOMMUN_BBOX,
    foretag: HAS_AE,   // företagsuppgifter (SCB) finns
    lokaltyper: LOKALTYPER.map(([typ]) => typ),
    agarkategorier: AGARKATEGORIER,
    upplatelseformer: UPPLATELSEFORMER,
    historiska: HIST_AUTH ? Object.keys(HIST_LAYERS).map(Number) : [],
    // Nyckel till Googles Maps Embed API. Den syns ändå i iframens adress; skyddet är hänvisarlåset hos Google.
    streetview: process.env.GOOGLE_EMBED_KEY || null,
    kortlankar: !!scenarier,   // scenarier kan sparas som korta länkar
    maxScenario: MAX_SCENARIO,
  }]],

  // Scenarier: underlaget för fastigheterna i ett scenario ({bet: [...]}), och spara/hämta (korta länkar).
  [/^\/api\/underlag$/, 'api', async (_m, _url, _res, req) => {
    const { varde, fel } = await lasJson(req, MAX_SCENARIO_BYTE);
    if (fel) return fel;
    const bet = varde?.bet;
    if (!Array.isArray(bet) || bet.length > MAX_SCENARIO || !bet.every((b) => typeof b === 'string')) {
      return [400, { error: `bet: högst ${MAX_SCENARIO} beteckningar` }];
    }
    const lista = JSON.stringify(bet.map(normBeteckning));
    const loa = new Map();
    for (const r of q.underlagLoa ? q.underlagLoa.all(lista) : []) (loa.get(r.beteckning) ?? loa.set(r.beteckning, {}).get(r.beteckning))[r.lokaltyp] = r.m2;
    return [200, { fastigheter: q.underlag.all(lista).map((f) => ({ ...f, loa: loa.get(f.beteckning) ?? {} })), byggd: META.byggd ?? null }];
  }, 'POST'],

  [/^\/api\/scenario$/, 'spara', async (_m, _url, _res, req) => {
    if (!scenarier) return [503, { error: 'Korta länkar är inte tillgängliga på servern.' }];
    const { varde, fel } = await lasJson(req, MAX_SCENARIO_BYTE);
    if (fel) return fel;
    if (!giltigtScenario(varde)) return [400, { error: 'ogiltigt scenario' }];
    const id = scenarier.spara(varde);
    return id ? [200, { id }] : [507, { error: 'Lagringen för scenarier är full.' }];
  }, 'POST'],

  // MFN: kontrollfrågan när en prenumeration läggs upp via deras hub (svaret är hub.challenge), och
  // pressmeddelandena (se MFN_DB ovan). 200 betyder mottaget; annars försöker MFN igen.
  [/^\/api\/mfn$/, 'api', (_m, url) => {
    const c = url.searchParams.get('hub.challenge');
    if (!qm) return [404, { error: 'okänd endpoint' }];
    return c && c.length <= 200 ? [200, c] : [400, { error: 'hub.challenge saknas' }];
  }],
  [/^\/api\/mfn$/, 'mfn', async (_m, _url, _res, req) => {
    if (!qm) return [404, { error: 'okänd endpoint' }];
    const { kropp, fel } = await lasKropp(req, MAX_MFN_BYTE);
    // Avvisade loggas också: annars syns det inte om MFN skickar för stort eller med fel hemlighet.
    if (fel) { console.log(`MFN avvisad: större än ${MAX_MFN_BYTE / 1024 / 1024} MB`); return fel; }
    if (!mfnSignaturOk(kropp, req.headers['x-hub-signature'])) { console.log('MFN avvisad: fel signatur'); return [403, { error: 'fel signatur' }]; }
    let item;
    try { item = JSON.parse(kropp); } catch { return [400, { error: 'ogiltig JSON' }]; }
    const n = tolkaMfn(item);
    if (n) qm.run(n.url, n.utgivare, n.rubrik, n.datum, n.typ, n.pris_kr, n.kommun, JSON.stringify(n.beteckningar), JSON.stringify(n.adresser), n.orgnr);
    // En rad per pressmeddelande i journalen, så att leveransen syns (bara den publika länken).
    const vad = !n ? 'ingen affär' : arFastighetsbolag(n.orgnr, n.orgnr && bolagFor.get(n.orgnr), n.utgivare) ? 'affär' : 'affär, inte fastighetsbolag';
    console.log(`MFN ${vad}: ${String(item?.url ?? '?').slice(0, 200)}`);
    return [200, { sparad: !!n }];
  }, 'POST'],

  // Inläsning från fil: {rader: [{bet, adress, kommun}]} -> {traffar: [{beteckning, via}]} i samma ordning (se matchaRad).
  // Samma hastighetsgräns som sparandet: en fil åt gången, upp till MAX_SCENARIO rader.
  [/^\/api\/matcha$/, 'spara', async (_m, _url, _res, req) => {
    const { varde, fel } = await lasJson(req, MAX_SCENARIO_BYTE);
    if (fel) return fel;
    const rader = varde?.rader;
    if (!Array.isArray(rader) || rader.length > MAX_SCENARIO) return [400, { error: `rader: högst ${MAX_SCENARIO}` }];
    return [200, { traffar: rader.map(matchaRad) }];
  }, 'POST'],

  [/^\/api\/scenario\/([\w-]{10})$/, 'api', (m) => {
    const data = scenarier?.hamta(m[1]);
    return data ? [200, data] : [404, { error: 'Scenariot finns inte' }];
  }],

  [/^\/api\/fastigheter$/, 'api', (_m, url) => {
    const rows = traffar(url);
    if (!rows) return [400, { error: 'bbox=minLon,minLat,maxLon,maxLat krävs' }];
    const features = rows.slice(0, MAX_FEATURES).map((r) =>
      featureJson(r.geojson, { beteckning: r.beteckning, varde_tkr: r.varde_tkr, agare: r.agare, demo: r.demo,
        areal_m2: r.areal_m2, typ: r.typ, agartyp: r.agartyp, kop_ar: r.kop_dag ? Number(r.kop_dag.slice(0, 4)) : null }));
    return [200, `{"type":"FeatureCollection","truncated":${rows.length > MAX_FEATURES},"features":[${features.join(',')}]}`];
  }],

  // Prickar vid låg zoom: [lon, lat, beteckning, värde (tkr), typ, ägartyp, köpår, demo, areal] per fastighet.
  [/^\/api\/punkter$/, 'api', (_m, url) => {
    const rows = traffar(url, q.punkter);
    if (!rows) return [400, { error: 'bbox=minLon,minLat,maxLon,maxLat krävs' }];
    const p = rows.slice(0, MAX_PUNKTER).map((r) => [+r.lon.toFixed(5), +r.lat.toFixed(5), r.beteckning, r.varde_tkr,
      r.typ, r.agartyp, r.kop_dag ? Number(r.kop_dag.slice(0, 4)) : null, r.demo, r.areal_m2 && Math.round(r.areal_m2)]);
    return [200, { truncated: rows.length > MAX_PUNKTER, p }];
  }],

  // Antal per kommun med kartfiltren (bbox ignoreras): [lon, lat, kommun, antal, värde (tkr)].
  [/^\/api\/kommunkluster$/, 'api', (_m, url) => {
    const p = filterParams(url), nyckel = p.join('|');
    if (!klusterCache.has(nyckel)) {
      if (klusterCache.size >= 500) klusterCache.clear();
      klusterCache.set(nyckel, q.kommunKluster.all(-180, 180, -90, 90, null, null, ...p)
        .map((r) => [r.lon, r.lat, r.kommun, r.n, r.varde_tkr]));
    }
    return [200, { k: klusterCache.get(nyckel) }];
  }],

  [/^\/api\/fastighet\/(.+)$/, 'api', (m) => {
    const bet = normBeteckning(decodeURIComponent(m[1]));
    const f = q.fastighet.get(bet);
    if (!f) return [404, { error: 'Fastigheten finns inte' }];
    return [200, { ...f, upplatelse: q.upplatelse.get(bet).u, adresser: adresserPa(bet), planer: planerPa(bet), taxering: q.taxering.all(bet), agare: q.agare.all(bet), transaktioner: q.transaktioner.all(bet).map((x) => x.forvarvare_orgnr ? x : { privat: true }),
      hyresgaster: q.hyresgaster ? q.hyresgaster.all(bet) : [], anvandning: q.anvandning ? q.anvandning.all(bet) : [],
      nyheter: qn ? qn.fastighet.all(bet, bet).map(publikNyhet) : [],
      ...omgivning(bet), ...miljoRisk(bet) }];
  }],

  [/^\/api\/planer$/, 'api', (_m, url) => {
    const bbox = (url.searchParams.get('bbox') ?? '').split(',').map(Number);
    if (bbox.length !== 4 || bbox.some(Number.isNaN)) return [400, { error: 'bbox=minLon,minLat,maxLon,maxLat krävs' }];
    const [minx, miny, maxx, maxy] = bbox;
    const rows = q.planerIBbox ? q.planerIBbox.all(minx, maxx, miny, maxy) : [];
    const features = rows.slice(0, MAX_FEATURES).map(({ geojson, ...p }) => featureJson(geojson, p));
    return [200, `{"type":"FeatureCollection","truncated":${rows.length > MAX_FEATURES},"features":[${features.join(',')}]}`];
  }],

  // Sökningen cachas inte (godtyckliga nycklar) och har därför en egen, lägre gräns.
  [/^\/api\/affarer$/, 'api', (_m, url, _res, req) => (url.searchParams.get('sok') && rateLimited(req, 'sok')
    ? [429, { error: 'för många sökningar, försök igen om en stund' }] : [200, affarer(url)])],
  [/^\/api\/storsta-agare$/, 'api', (_m, url) => [200, storsta(url)]],

  [/^\/api\/bolag\/([\d-]+)$/, 'api', (m) => {
    const orgnr = normOrgnr(m[1]);
    const b = orgnr && q.bolag.get(orgnr);
    if (!b) return [404, { error: 'Bolaget finns inte bland importerade juridiska personer' }];
    return [200, { ...b, fastigheter: q.bolagFastigheter.all(orgnr, orgnr), summa: bolagSumma(orgnr), kop: q.bolagKop.all(orgnr), salt: q.bolagSalt.all(orgnr),
      arbetsstallen: q.arbetsstallen ? q.arbetsstallen.all(orgnr) : [] }];
  }],

  [/^\/api\/sok$/, 'api', (_m, url) => {
    const term = (url.searchParams.get('q') ?? '').trim();
    if (term.length < 2) return [200, { adresser: [], bolag: [], fastigheter: [] }];
    const orgnr = normOrgnr(term);
    const bolag = orgnr ? [q.bolag.get(orgnr)].filter(Boolean).map(bolagTraff) : sokBolag(term);
    return [200, { adresser: orgnr ? [] : sokAdress(term), bolag, fastigheter: orgnr || !ftsQuery(term) ? [] : q.sokFastighet.all(ftsQuery(term)) }];
  }],

  [/^\/tiles\/satellit\/(\d{1,2})\/(\d{1,6})\/(\d{1,6})\.jpg$/, 'tiles',
    (m, _url, res) => satellitTile(res, ...m.slice(1).map(Number))],

  [/^\/tiles\/historisk\/(\d{4})\/(\d{1,2})\/(\d{1,6})\/(\d{1,6})\.jpg$/, 'historisk',
    (m, _url, res) => historiskTile(res, ...m.slice(1).map(Number))],

  [/^\/data\/horos-traffar\.csv$/, 'api', (_m, url, res) => {
    const rows = traffar(url, q.traffCsv);
    if (!rows) return [400, { error: 'bbox=minLon,minLat,maxLon,maxLat krävs' }];
    res.writeHead(200, {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': 'attachment; filename="horos-traffar.csv"',
      'cache-control': 'no-store',
    });
    res.end(toCsv(TRAFF_COLS, rows.slice(0, MAX_FEATURES)));
  }],

  // Det gamla filnamnet (-stockholm) fungerar fortfarande för befintliga länkar.
  [/^\/data\/horos-fastigheter(?:-stockholm)?\.(csv|geojson)$/, 'export', async (m, _url, res) => {
    const kind = m[1];
    if (kind === 'geojson' && !EXPORT_GEOMETRI) {
      return [403, { error: 'Fastighetsgränserna får inte laddas ner som fil ännu (väntar på Lantmäteriets villkor).' }];
    }
    res.writeHead(200, {
      'content-type': kind === 'csv' ? 'text/csv; charset=utf-8' : 'application/geo+json; charset=utf-8',
      'content-disposition': `attachment; filename="horos-fastigheter.${kind}"`,
      'cache-control': 'public, max-age=3600',
    });
    if (kind === 'csv') await pipeline(Readable.from(csvRader(q.exportCsv.iterate())), res);
    else res.end(buildExport());
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
  try {
    let url;
    try { url = new URL(req.url, 'http://localhost'); }
    catch { return json(res, 400, { error: 'ogiltig URL' }); }
    // Samma adress kan ha en rutt per metod (t.ex. /api/mfn).
    const passar = routes.filter(([re]) => re.test(url.pathname));
    const route = passar.find(([, , , m = 'GET']) => req.method === m || (m === 'GET' && req.method === 'HEAD')) ?? passar[0];
    const metod = route?.[3] ?? 'GET';
    if (req.method !== metod && !(metod === 'GET' && req.method === 'HEAD')) return json(res, 405, { error: `endast ${passar.map((r) => r[3] ?? 'GET').join(', ')}` });
    if (rateLimited(req, route?.[1] ?? 'api')) return json(res, 429, { error: 'för många förfrågningar, försök igen om en stund' });
    if (route) {
      const out = await route[2](url.pathname.match(route[0]), url, res, req);
      if (out) json(res, ...out);
      return;
    }
    if (url.pathname.startsWith('/api/')) return json(res, 404, { error: 'okänd endpoint' });
    await serveStatic(res, url.pathname);
  } catch (e) {
    console.error(e);
    if (res.headersSent) return res.destroy();
    json(res, 500, { error: PUBLIC_MODE ? 'internt fel' : String(e.message ?? e) });
  }
}).listen(PORT, HOST, () => console.log(`Horos${PUBLIC_MODE ? ' (publikt läge)' : ''}: http://${HOST}:${PORT}`));
