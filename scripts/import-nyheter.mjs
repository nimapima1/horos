// Hämtar fastighetsbolagens pressmeddelanden från Cision (RSS), eller läser dem som MFN skickat, och sparar köp och försäljningar av
// fastigheter i nyhet/nyhet_plats: rubrik, länk, datum, typ, pris och platser. Texten sparas inte.
// Fastigheter hittas via beteckningen i texten (kommun + trakt) eller adressen (adresspunkt -> fastighet).
//
//   node scripts/import-nyheter.mjs [--dry]   (--dry: visa vad som hittas, spara inget)
//   node scripts/import-nyheter.mjs --publik <fil>   (servern, deploy/nyheter.sh: en kopia av den publika databasen;
//                                                     slutkod 3 = inget ändrades)
//   node scripts/import-nyheter.mjs --publik <ny> --behall <gammal>   (deploy --data: pressmeddelanden som bara
//                                                     finns i den gamla publika databasen följer med, ingen hämtning)
//   node scripts/import-nyheter.mjs --publik <fil> --mfn <mfn.sqlite> [--undanta <fil>]   (servern: det som MFN
//                                                     skickat till /api/mfn, utom url:er i --undanta; ingen hämtning)
import { existsSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { NYHET_PLATS_UTANFOR, openDb, rebuildRtree, withTransaction } from '../lib/db.mjs';
import { parseArgs } from '../lib/csv.mjs';
import { pointInGeom } from '../lib/geo.mjs';
import { CISION, TIDNINGAR, aktorIRubrik, arFastighetsbolag, lasRss, tolka, nyhetsRubrik, publiceraNyheter } from '../lib/nyheter.mjs';

const args = parseArgs(process.argv.slice(2));
const UA = 'Horos/0.1 (ideell fastighetskarta; kontakt@horos.se)';
const vanta = (ms) => new Promise((r) => setTimeout(r, ms));

// Den publika databasen öppnas utan openDb: schemat skulle skapa tabeller som gör att servern vägrar starta.
const db = args.publik ? new DatabaseSync(args.publik) : openDb();
// Indexet för dubblettkontrollen (lib/db.mjs) även i publika databaser byggda före det.
if (args.publik) db.exec('CREATE INDEX IF NOT EXISTS nyhet_affar ON nyhet(typ, pris_kr, datum)');
if (!args.publik) rebuildRtree(db, 'fastighet');

// Cron hämtar pressmeddelanden på servern, så den gamla publika databasen kan ha sådana som den nya
// (byggd lokalt) saknar. Platserna följer bara med på fastigheter i den nya.
if (args.publik && args.behall) {
  db.exec(`ATTACH DATABASE '${String(args.behall).replace(/'/g, "''")}' AS gammal`);
  withTransaction(db, () => db.exec(`
    CREATE TEMP TABLE bara_gamla AS SELECT url FROM gammal.nyhet WHERE url NOT IN (SELECT url FROM main.nyhet);
    INSERT INTO main.nyhet SELECT * FROM gammal.nyhet WHERE url IN (SELECT url FROM bara_gamla);
    INSERT INTO main.nyhet_plats SELECT * FROM gammal.nyhet_plats
      WHERE url IN (SELECT url FROM bara_gamla) AND NOT ${NYHET_PLATS_UTANFOR};`));
  publiceraNyheter(db);
  console.log(`Behöll ${db.prepare('SELECT count(*) AS n FROM bara_gamla').get().n} pressmeddelanden som bara fanns på servern.`);
  process.exit(0);
}

// Innehållet i nyhet/nyhet_plats, för att se om något ändrades (då behöver servern inte startas om).
const innehall = () => db.prepare(`SELECT
  (SELECT json_group_array(json_array(url, kalla, utgivare, rubrik, datum, typ, pris_kr, kommun)) FROM (SELECT * FROM nyhet ORDER BY url))
  || (SELECT json_group_array(json_array(url, beteckning, adress, lon, lat)) FROM (SELECT * FROM nyhet_plats ORDER BY 1, 2, 3, 4, 5)) AS s`).get().s;
const fore = args.publik && innehall();
const finnsFastighet = db.prepare('SELECT 1 FROM fastighet WHERE beteckning = ?');
const adresser = db.prepare('SELECT lon, lat, ort FROM adress WHERE gata = ? COLLATE NOCASE AND nummer = ?');
const kandidater = db.prepare(`SELECT f.beteckning, f.geojson FROM fastighet f
  WHERE f.rowid IN (SELECT id FROM fastighet_rtree WHERE maxx >= ? AND minx <= ? AND maxy >= ? AND miny <= ?)`);
const fastighetVid = (lon, lat) =>
  kandidater.all(lon, lon, lat, lat).find((f) => pointInGeom([lon, lat], JSON.parse(f.geojson)))?.beteckning ?? null;
const nyhetsBolag = db.prepare('SELECT namn FROM bolag WHERE orgnr = ?');
const insNyhet = db.prepare(`INSERT OR REPLACE INTO nyhet (url, kalla, utgivare, rubrik, datum, typ, pris_kr, kommun)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
const delPlats = db.prepare('DELETE FROM nyhet_plats WHERE url = ?');
const delNyhet = db.prepare('DELETE FROM nyhet WHERE url = ?');
const insPlats = db.prepare('INSERT INTO nyhet_plats (url, beteckning, adress, lon, lat) VALUES (?, ?, ?, ?, ?)');

const fastighetensKommun = db.prepare('SELECT kommun FROM fastighet WHERE beteckning = ?');

// Adressen i texten -> en punkt i den kommun som texten nämner. Adresstabellen täcker inte hela landet,
// så en ensam träff på samma gatunamn kan ligga i en annan stad (Kungsgatan 44 i Göteborg ≠ i Stockholm).
// Kommunen tas från fastigheten under punkten, annars från adressens ort.
function adressPunkt({ gata, nummer }, kommun) {
  if (!kommun) return null;
  const rader = adresser.all(gata, nummer).map((a) => ({ ...a, bet: fastighetVid(a.lon, a.lat) }));
  // Publikt saknas fastigheterna utan juridisk ägare, så kommunen för en sådan träff är okänd och en annan
  // träff kunde väljas än lokalt. En adress som finns på flera ställen hoppas därför över.
  if (args.publik && new Set(rader.map((a) => a.bet ?? `${a.lon},${a.lat}`)).size > 1) return null;
  return rader.find((a) => (a.bet ? fastighetensKommun.get(a.bet)?.kommun : a.ort) === kommun) ?? null;
}

let antal = 0, medPlats = 0;
// En affär (från tolka) med platser: beteckningarna i texten och adresspunkterna.
function spara(n, utgivare, kalla) {
  // Lokalt sparas kandidatbeteckningar även om fastigheten inte finns än, så att de kopplas när den läses in.
  // Publikt (--publik) tas platser utan fastighet i databasen bort efter hämtningen, som i build-public.
  const platser = n.beteckningar.map((b) => [b, null, null, null]);
  for (const a of n.adresser) {
    const p = adressPunkt(a, n.kommun);
    if (p) platser.push([p.bet, `${a.gata} ${a.nummer}`, p.lon, p.lat]);
  }
  const kopplade = platser.filter(([b, , lon]) => finnsFastighet.get(b) || (lon != null && !args.publik)).length;
  antal++; if (kopplade) medPlats++;
  if (args.dry) {
    console.log(`${n.datum?.slice(0, 10)} ${n.typ} ${n.pris_kr ? `${n.pris_kr / 1e6} Mkr` : '–'} ${n.rubrik}`
      + `\n    ${n.kommun ?? 'ingen kommun'} · ${n.beteckningar.join(', ') || 'ingen beteckning'} · ${n.adresser.map((x) => `${x.gata} ${x.nummer}`).join(', ') || 'ingen adress'} · ${kopplade} på kartan`);
    return;
  }
  insNyhet.run(n.url, kalla, utgivare, nyhetsRubrik({ ...n, utgivare }, kalla === 'mfn' ? nyhetsBolag.get(n.orgnr)?.namn : null), n.datum, n.typ, n.pris_kr, n.kommun);
  delPlats.run(n.url);
  for (const p of platser) insPlats.run(n.url, ...p);
}

if (args.mfn) {
  // Det som MFN skickat till servern (POST /api/mfn i server.mjs), redan tolkat och utan text.
  // shortcut: tolkas inte om när reglerna i lib/nyheter.mjs ändras (texten sparas inte); bara nya följer dem.
  const mdb = new DatabaseSync(String(args.mfn), { readOnly: true, timeout: 5000 });   // appen kan skriva just då
  const rader = mdb.prepare('SELECT * FROM mfn_nyhet').all();
  mdb.close();
  // Ett felaktigt pressmeddelande tas bort genom att dess url läggs på en rad i --undanta-filen (deploy får
  // skriva den; mfn.sqlite ägs av appen).
  const undanta = new Set(args.undanta && existsSync(String(args.undanta))
    ? readFileSync(String(args.undanta), 'utf8').split(/\r?\n/).map((s) => s.trim()).filter(Boolean) : []);
  // MFN skickar alla bolags affärer: bara fastighetsbolagens tas med (rader utan org.nr, från före filtret, inte).
  const bolagFor = db.prepare('SELECT namn, sni FROM bolag WHERE orgnr = ?');
  const tas = (r) => !undanta.has(r.url) && arFastighetsbolag(r.orgnr, r.orgnr && bolagFor.get(r.orgnr), r.utgivare);
  withTransaction(db, () => {
    for (const r of rader) if (!tas(r) && !args.dry) { delNyhet.run(r.url); delPlats.run(r.url); }
    for (const url of undanta) if (!args.dry) { delNyhet.run(url); delPlats.run(url); }
    for (const r of rader.filter(tas)) spara({ ...r, beteckningar: JSON.parse(r.beteckningar), adresser: JSON.parse(r.adresser) }, r.utgivare, 'mfn');
  });
} else {
  // En tidningsrubrik kan nämna en privatperson: bara affärer där den som köper eller säljer är ett bolag i registret.
  const bolagFts = db.prepare('SELECT 1 FROM bolag_fts WHERE bolag_fts MATCH ? LIMIT 1');
  const arBolag = (namn) => {
    const ord = namn?.match(/[\p{L}\p{N}]+/gu);
    return !!ord && ord.length <= 4 && !!bolagFts.get(ord.map((o) => `"${o}"`).join(' '));
  };
  const kallor = [...CISION.map(([namn, utgivare]) => ['cision', utgivare,
    `https://news.cision.com/se/${namn}/ListItems?format=rss&pageSize=100`, 'https://news.cision.com/']), ...TIDNINGAR];
  for (const [kalla, utgivare, flode, lank] of kallor) {
    const res = await fetch(flode, { headers: { 'user-agent': UA } });
    if (!res.ok) { console.error(`${utgivare}: svarade ${res.status}`); continue; }
    const alla = lasRss(await res.text()).map((n) => ({ ...n, ...tolka(n) }));
    const affarer = alla.filter((n) => n.typ && n.url.startsWith(lank)   // länken visas på sidan
      && (kalla === 'cision' || arBolag(aktorIRubrik(n.rubrik))));
    withTransaction(db, () => {
      // Det som inte (längre) räknas som affärer, t.ex. efter ändrade regler i lib/nyheter.mjs.
      if (!args.dry) for (const n of alla) if (!affarer.includes(n)) { delNyhet.run(n.url); delPlats.run(n.url); }
      for (const n of affarer) spara(n, utgivare, kalla);
    });
    await vanta(1000);   // en förfrågan i sekunden
  }
}
// Avbryts hämtningen blir slutkoden fel och deploy/nyheter.sh kastar kopian, så det räcker att städa här.
if (args.publik && !args.dry) db.exec(`DELETE FROM nyhet_plats WHERE ${NYHET_PLATS_UTANFOR}`);
if (args.publik && !args.dry) publiceraNyheter(db);
const oforandrat = args.publik && innehall() === fore;
console.log(`${args.dry ? 'Torrkörning: ' : 'Klart: '}${antal} affärer i pressmeddelanden, ${medPlats} med plats på kartan`
  + `${oforandrat ? ' (inget ändrades)' : ''}.`);
if (oforandrat) process.exitCode = 3;
