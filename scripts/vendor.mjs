// Kopierar MapLibre (CSP-versionen) från node_modules till public/vendor/ så att
// sidan inte hämtar skript från en tredje part (besökarnas IP-adresser stannar hos oss).
import { copyFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from '../lib/db.mjs';

const src = join(ROOT, 'node_modules', 'maplibre-gl', 'dist');
const dst = join(ROOT, 'public', 'vendor');
mkdirSync(dst, { recursive: true });
for (const f of ['maplibre-gl-csp.js', 'maplibre-gl-csp-worker.js', 'maplibre-gl.css', 'LICENSE.txt']) {
  copyFileSync(join(src, f), join(dst, f === 'LICENSE.txt' ? 'maplibre-LICENSE.txt' : f));
}
console.log(`MapLibre kopierat till ${dst}`);
