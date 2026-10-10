// Hämtar fastighetsbolagens pressmeddelanden från Cision (RSS) och sparar köp och försäljningar av
// fastigheter i nyhet/nyhet_plats: rubrik, länk, datum, typ, pris och platser. Texten sparas inte.
// Fastigheter hittas via beteckningen i texten (kommun + trakt) eller adressen (adresspunkt -> fastighet).
//
//   node scripts/import-nyheter.mjs [--dry]   (--dry: visa vad som hittas, spara inget)
import { openDb, rebuildRtree, withTransaction } from '../lib/db.mjs';
import { parseArgs } from '../lib/csv.mjs';
import { pointInGeom } from '../lib/geo.mjs';
import { CISION, lasRss, tolka } from '../lib/nyheter.mjs';

const args = parseArgs(process.argv.slice(2));
const UA = 'Horos/0.1 (ideell fastighetskarta; nima.behnejad@gmail.com)';
const vanta = (ms) => new Promise((r) => setTimeout(r, ms));

const db = openDb();
rebuildRtree(db, 'fastighet');
const finnsFastighet = db.prepare('SELECT 1 FROM fastighet WHERE beteckning = ?');
const adresser = db.prepare('SELECT lon, lat, ort FROM adress WHERE gata = ? COLLATE NOCASE AND nummer = ?');
const kandidater = db.prepare(`SELECT f.beteckning, f.geojson FROM fastighet f
  WHERE f.rowid IN (SELECT id FROM fastighet_rtree WHERE maxx >= ? AND minx <= ? AND maxy >= ? AND miny <= ?)`);
const fastighetVid = (lon, lat) =>
  kandidater.all(lon, lon, lat, lat).find((f) => pointInGeom([lon, lat], JSON.parse(f.geojson)))?.beteckning ?? null;
const insNyhet = db.prepare(`INSERT OR REPLACE INTO nyhet (url, kalla, utgivare, rubrik, datum, typ, pris_kr, kommun)
  VALUES (?, 'cision', ?, ?, ?, ?, ?, ?)`);
const delPlats = db.prepare('DELETE FROM nyhet_plats WHERE url = ?');
const insPlats = db.prepare('INSERT INTO nyhet_plats (url, beteckning, adress, lon, lat) VALUES (?, ?, ?, ?, ?)');

// Adressen i texten -> en punkt: en enda träff, annars den i en kommun som texten nämner.
function adressPunkt({ gata, nummer }, kommun) {
  const t = adresser.all(gata, nummer);
  return t.length === 1 ? t[0] : t.find((a) => kommun && a.ort === kommun) ?? null;
}

let antal = 0, medPlats = 0;
for (const [namn, utgivare] of CISION) {
  const res = await fetch(`https://news.cision.com/se/${namn}/ListItems?format=rss&pageSize=100`, { headers: { 'user-agent': UA } });
  if (!res.ok) { console.error(`${utgivare}: Cision svarade ${res.status}`); continue; }
  const affarer = lasRss(await res.text()).map((n) => ({ ...n, ...tolka(n) }))
    .filter((n) => n.typ && n.url.startsWith('https://news.cision.com/'));   // länken visas på sidan
  withTransaction(db, () => {
    for (const n of affarer) {
      // Kandidatbeteckningar sparas även om fastigheten inte finns än, så att de kopplas när den läses in.
      const platser = n.beteckningar.map((b) => [b, null, null, null]);
      for (const a of n.adresser) {
        const p = adressPunkt(a, n.kommun);
        if (p) platser.push([fastighetVid(p.lon, p.lat), `${a.gata} ${a.nummer}`, p.lon, p.lat]);
      }
      const kopplade = platser.filter(([b, , lon]) => lon != null || finnsFastighet.get(b)).length;
      antal++; if (kopplade) medPlats++;
      if (args.dry) {
        console.log(`${n.datum?.slice(0, 10)} ${n.typ} ${n.pris_kr ? `${n.pris_kr / 1e6} Mkr` : '–'} ${n.rubrik}`
          + `\n    ${n.kommun ?? 'ingen kommun'} · ${n.beteckningar.join(', ') || 'ingen beteckning'} · ${n.adresser.map((x) => `${x.gata} ${x.nummer}`).join(', ') || 'ingen adress'} · ${kopplade} på kartan`);
        continue;
      }
      insNyhet.run(n.url, utgivare, n.rubrik, n.datum, n.typ, n.pris_kr, n.kommun);
      delPlats.run(n.url);
      for (const p of platser) insPlats.run(n.url, ...p);
    }
  });
  await vanta(1000);   // en förfrågan i sekunden
}
console.log(`${args.dry ? 'Torrkörning: ' : 'Klart: '}${antal} affärer i pressmeddelanden, ${medPlats} med plats på kartan.`);
