// Bygger kartrutor (XYZ, WebP) av Lantmäteriets ortofoto från STAC-katalogen
// (https://api.lantmateriet.se/stac-bild/v1, CC BY 4.0). Bildfilerna kräver Geotorget-inloggningen
// (GEOTORGET_USER/GEOTORGET_PASS). Körs på servern via deploy/ortofoto.sh, som installerar GDAL.
//
//   node scripts/bygg-ortofoto.mjs --samling orto-o2-2025 [--bbox 17.75,59.22,18.21,59.45] [--dry]
//
// Rutorna slutar på zoom 18 (~0,3 m/pixel i Stockholm): åtagandet är högst ~0,3 m, och bilderna
// laddas inte ner av besökarna. Varje bild läses i den översikt som ligger närmast 0,3 m, så att inte
// mer än nödvändigt hämtas. Källfilerna sparas (en omkörning hämtar bara det som saknas).
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, renameSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from '../lib/db.mjs';
import { parseArgs } from '../lib/csv.mjs';

const STAC = 'https://api.lantmateriet.se/stac-bild/v1';
const MAX_ZOOM = 18;
const MAX_UPPLOSNING = 0.3;   // m/pixel; finare källor läses i en översikt

const args = parseArgs(process.argv.slice(2));
const samling = args.samling;
if (typeof samling !== 'string') { console.error('Ange --samling, t.ex. orto-o2-2025 (se kommentaren överst).'); process.exit(1); }
const bbox = String(args.bbox ?? '17.75,59.22,18.21,59.45');   // Stockholms kommun
const TILES = args.ut ?? join(process.env.TILES_DIR ?? join(ROOT, 'data', 'tiles'), 'ortofoto');
const KALLA = args.kalla ?? join(TILES, '..', 'ortofoto-kalla', samling);

// Alla bilder i samlingen inom bbox (katalogen delar upp svaret i sidor).
const bilder = [];
for (let url = `${STAC}/search?collections=${encodeURIComponent(samling)}&bbox=${bbox}&limit=100`; url;) {
  const r = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error(`STAC svarade ${r.status} för ${url}`);
  const sida = await r.json();
  bilder.push(...sida.features);
  url = sida.links?.find((l) => l.rel === 'next')?.href;
}
if (!bilder.length) { console.error(`Inga bilder i ${samling} inom ${bbox}.`); process.exit(1); }
const ar = bilder[0].properties.flygar;
if (bilder.some((b) => b.properties.flygar !== ar)) throw new Error('Samlingen innehåller flera flygår; ange en samling per år.');
const upplosning = Math.max(...bilder.map((b) => b.properties.upplosning));
console.log(`${bilder.length} bilder från ${ar} (${upplosning} m/pixel) i ${samling}.`);
if (args.dry) { console.log('Exempel:', bilder[0].assets.data.href); process.exit(0); }

if (!process.env.GEOTORGET_USER || !process.env.GEOTORGET_PASS) throw new Error('GEOTORGET_USER och GEOTORGET_PASS krävs.');
const env = {
  ...process.env,
  GDAL_HTTP_AUTH: 'BASIC',
  GDAL_HTTP_USERPWD: `${process.env.GEOTORGET_USER}:${process.env.GEOTORGET_PASS}`,
  GDAL_DISABLE_READDIR_ON_OPEN: 'EMPTY_DIR',
  CPL_VSIL_CURL_ALLOWED_EXTENSIONS: '.tif',
  GDAL_HTTP_MAX_RETRY: '5', GDAL_HTTP_RETRY_DELAY: '3',
};
const gdal = (cmd, argv) => execFileSync(cmd, argv, { env, stdio: ['ignore', 'pipe', 'inherit'] }).toString();

// 1. Källfilerna: band 1–3 (RGB; bildernas fjärde band är infrarött), i översikten närmast 0,3 m.
mkdirSync(KALLA, { recursive: true });
let i = 0;
for (const b of bilder) {
  const fil = join(KALLA, `${b.id}.tif`);
  i++;
  if (existsSync(fil)) continue;
  // Översikterna halverar upplösningen: nivå 0 är 2 × originalet.
  let niva = -1;
  while (b.properties.upplosning * 2 ** (niva + 1) < MAX_UPPLOSNING) niva++;
  const ovr = niva >= 0 ? ['-oo', `OVERVIEW_LEVEL=${niva}`] : [];
  gdal('gdal_translate', [...ovr, '-b', '1', '-b', '2', '-b', '3', '-co', 'COMPRESS=JPEG', '-co', 'PHOTOMETRIC=YCBCR',
    '-co', 'TILED=YES', '-q', `/vsicurl/${b.assets.data.href}`, `${fil}.tmp.tif`]);
  renameSync(`${fil}.tmp.tif`, fil);
  console.log(`${i}/${bilder.length} ${b.id}`);
}

// 2. Rutorna, i en ny katalog som byter plats med den gamla först när allt är klart.
const vrt = join(KALLA, 'mosaik.vrt');
gdal('gdalbuildvrt', ['-q', vrt, ...readdirSync(KALLA).filter((f) => /^[^.]+\.tif$/.test(f)).map((f) => join(KALLA, f))]);
const ut = join(TILES, String(ar)), ny = `${ut}.ny`;
if (existsSync(ny)) throw new Error(`${ny} finns redan (avbruten körning?). Döp om den och kör igen.`);
const gdal2tiles = ['gdal2tiles.py', 'gdal2tiles'].find((c) => { try { execFileSync('which', [c]); return true; } catch { return false; } });
if (!gdal2tiles) throw new Error('gdal2tiles saknas (apt install python3-gdal).');
gdal(gdal2tiles, ['--xyz', '-z', `10-${MAX_ZOOM}`, '-r', 'average', '-w', 'none', '--tiledriver=WEBP', '--webp-quality=80',
  `--processes=${args.processer ?? 2}`, vrt, ny]);
const ext = JSON.parse(gdal('gdalinfo', ['-json', vrt])).wgs84Extent.coordinates[0];
const lon = ext.map((p) => p[0]), lat = ext.map((p) => p[1]);
writeFileSync(join(ny, 'bounds.json'), JSON.stringify({ ar, samling, upplosning, maxzoom: MAX_ZOOM,
  bounds: [Math.min(...lon), Math.min(...lat), Math.max(...lon), Math.max(...lat)].map((v) => Math.round(v * 1e5) / 1e5) }));
if (existsSync(ut)) {
  if (existsSync(`${ut}_GAMMAL`)) throw new Error(`${ut}_GAMMAL finns redan; flytta den först. De nya rutorna ligger i ${ny}.`);
  renameSync(ut, `${ut}_GAMMAL`);
}
renameSync(ny, ut);
console.log(`Klart: rutor för ${ar} i ${ut}. Starta om appen så att den hittar dem.`);
