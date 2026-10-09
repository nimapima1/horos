// Kopierar MapLibre (CSP-versionen) och typsnitten från node_modules till public/vendor/ så att
// sidan inte hämtar något från tredje part (besökarnas IP-adresser stannar hos oss).
import { copyFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from '../lib/db.mjs';

const nm = join(ROOT, 'node_modules');
const dst = join(ROOT, 'public', 'vendor');
const FILES = {
  'maplibre-gl/dist/maplibre-gl-csp.js': 'maplibre-gl-csp.js',
  'maplibre-gl/dist/maplibre-gl-csp-worker.js': 'maplibre-gl-csp-worker.js',
  'maplibre-gl/dist/maplibre-gl.css': 'maplibre-gl.css',
  'maplibre-gl/LICENSE.txt': 'maplibre-LICENSE.txt',
  // Latin-delmängden täcker å, ä och ö. Variabla typsnitt: en fil för alla vikter.
  '@fontsource-variable/lexend/files/lexend-latin-wght-normal.woff2': 'lexend.woff2',
  '@fontsource-variable/lexend/LICENSE': 'lexend-LICENSE.txt',
  '@fontsource-variable/source-sans-3/files/source-sans-3-latin-wght-normal.woff2': 'source-sans-3.woff2',
  '@fontsource-variable/source-sans-3/LICENSE': 'source-sans-3-LICENSE.txt',
};
mkdirSync(dst, { recursive: true });
for (const [from, to] of Object.entries(FILES)) copyFileSync(join(nm, from), join(dst, to));
console.log(`Kopierade ${Object.keys(FILES).length} filer till ${dst}`);
