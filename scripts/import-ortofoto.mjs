// Bygger registret över Lantmäteriets ortofoton (STAC-katalogen, bara metadata, ingen inloggning):
// den senaste färgbilden för varje ruta i rutnätet (2,5 km), för hela landet. Servern ritar kartrutor
// ur bilderna vid behov (se lib/ortofoto.mjs). Kör om när Lantmäteriet publicerat nya flygningar.
//
//   node scripts/import-ortofoto.mjs [--db data/ortofoto.sqlite] [--samling orto-o2-2025]
//
// Skriver till <db>.ny och byter fil när allt är klart; starta sedan om servern.
import { existsSync, renameSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DB_PATH } from '../lib/db.mjs';
import { parseArgs } from '../lib/csv.mjs';
import { STAC, oppnaRegister } from '../lib/ortofoto.mjs';

const args = parseArgs(process.argv.slice(2));
const ut = args.db ?? join(dirname(DB_PATH), 'ortofoto.sqlite');
const ny = `${ut}.ny`;

const hamta = async (url) => {
  for (let forsok = 1; ; forsok++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(60000), headers: { 'user-agent': 'horos/0.1 (ideell fastighetskarta)' } });
      if (r.ok) return await r.json();
      if (r.status < 500 || forsok >= 5) throw new Error(`STAC svarade ${r.status} för ${url}`);
    } catch (err) {
      if (forsok >= 5) throw err;
    }
    await new Promise((ok) => setTimeout(ok, 5000 * forsok));
  }
};

// De historiska samlingarna (RT90) ingår inte: de har eget lager i kartan.
const samlingar = typeof args.samling === 'string' ? [args.samling]
  : (await hamta(`${STAC}/collections?limit=2000`)).collections.map((c) => c.id).filter((id) => !id.includes('historiska'));
console.log(`${samlingar.length} samlingar.`);

rmSync(ny, { force: true });
const db = oppnaRegister(ny, { skriv: true });
// En rad per ruta i rutnätet (proj:bbox i SWEREF 99 TM); en nyare bild ersätter en äldre.
const spara = db.prepare(`INSERT INTO bild (namn, samling, href, datum, upplosning, ruta, geometri, minx, miny, maxx, maxy)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT (ruta) DO UPDATE SET namn = excluded.namn, samling = excluded.samling, href = excluded.href, datum = excluded.datum,
    upplosning = excluded.upplosning, geometri = excluded.geometri, minx = excluded.minx, miny = excluded.miny, maxx = excluded.maxx, maxy = excluded.maxy
  WHERE excluded.datum > bild.datum`);
const FALT = 'id,bbox,geometry,assets.data.href,properties.datetime,properties.upplosning,properties.proj:bbox';
let antal = 0;
for (const [i, samling] of samlingar.entries()) {
  let n = 0;
  for (let url = `${STAC}/search?collections=${encodeURIComponent(samling)}&limit=1000&fields=${FALT}`
    + `&filter=${encodeURIComponent("spektraltyp IN ('rgb','rgbi')")}`; url;) {
    const sida = await hamta(url);
    db.exec('BEGIN');
    for (const f of sida.features) {
      const p = f.properties;
      if (!f.assets?.data?.href || !p['proj:bbox'] || !f.bbox) continue;
      spara.run(f.id, samling, f.assets.data.href, p.datetime, p.upplosning, p['proj:bbox'].join(','),
        JSON.stringify(f.geometry), ...f.bbox);
      n++;
    }
    db.exec('COMMIT');
    url = sida.links?.find((l) => l.rel === 'next')?.href;
  }
  antal += n;
  console.log(`${i + 1}/${samlingar.length} ${samling}: ${n} bilder`);
}
db.exec(`INSERT INTO bild_rtree SELECT id, minx, maxx, miny, maxy FROM bild;
  INSERT INTO meta VALUES ('byggd', datetime('now'));`);
const rutor = db.prepare('SELECT count(*) AS n FROM bild').get().n;
db.close();
if (!rutor) { console.error('Inga bilder hittades; behåller det gamla registret.'); process.exit(1); }
if (existsSync(ut)) renameSync(ut, `${ut}_GAMMAL`);
renameSync(ny, ut);
console.log(`Klart: ${antal} bilder, ${rutor} rutor i ${ut}. Starta om servern.`);
