// Importerar arbetsställen från SCB:s företagsregister (avgiftsfritt API) till tabellen
// arbetsstalle och kopplar dem till fastigheterna med punkt-i-polygon på adresskoordinaten.
//
// Läses aldrig in: enskilda näringsidkare (personnummer), arbetsställen som inte är verksamma,
// och fiktiva arbetsställen (rörlig personal). Reklamspärren sparas och visas, eftersom SCB:s villkor
// kräver att den som sprider uppgifterna informerar om den. Telefon, e-post och postadress sparas inte.
//
//   node scripts/import-arbetsstallen.mjs [--dry] [--sidor N]
//   node scripts/import-arbetsstallen.mjs --fil sidor.json [--sni koder.json] [--dry]
//
// Utan --fil hämtas hela landet från https://apiafr.scb.se/v1/arbetsstallen/full (bara den
// varianten har koordinater) med nyckeln i miljövariabeln SCB_API_KEY, annars frågar skriptet
// efter den utan att visa den. Nyckeln är personlig och får inte delas.
// --sidor N: bara de N första sidorna (5 000 per sida), för att prova nyckeln och fälten.
// --fil: ett sparat svar ({arbetsstallen: [...]}) eller en lista av sådana. --sni: kodtabellen.
import { readFileSync } from 'node:fs';
import { openDb, normOrgnr, rebuildRtree } from '../lib/db.mjs';
import { parseArgs } from '../lib/csv.mjs';
import { pointInGeom, sweref99tmToWgs84 } from '../lib/geo.mjs';
import { lokaltyp, loaM2 } from '../lib/lokaltyp.mjs';
import { scbKlient } from '../lib/scb.mjs';

const args = parseArgs(process.argv.slice(2));
const scb = await scbKlient({ fil: args.fil });

const koder = args.sni ? JSON.parse(readFileSync(args.sni, 'utf8')) : args.fil ? [] : await scb.hamta('/kodtabeller/naringsgrenkoder');
const BRANSCH = new Map(koder.map((k) => [k.kod, k.klartext]));

const db = openDb();
rebuildRtree(db, 'fastighet');
const kandidater = db.prepare(`SELECT f.beteckning, f.geojson FROM fastighet f
  WHERE f.rowid IN (SELECT id FROM fastighet_rtree WHERE maxx >= ? AND minx <= ? AND maxy >= ? AND miny <= ?)`);
// Ingen cache av polygonerna: med hela landet skulle den växa till flera GB.
const fastighetVid = (lon, lat) =>
  kandidater.all(lon, lon, lat, lat).find((f) => pointInGeom([lon, lat], JSON.parse(f.geojson)))?.beteckning ?? null;

const ins = db.prepare(`INSERT OR REPLACE INTO arbetsstalle
  (cfar, orgnr, benamning, sni, avdelning, bransch, anstkl, adress, postnr, ort, lon, lat, beteckning, lokaltyp, loa_m2, reklamsparr)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

const n = { lasta: 0, person: 0, ejVerksam: 0, fiktiv: 0, reklamsparr: 0, utanKoord: 0, sparade: 0, kopplade: 0 };
const tom = (s) => (s && String(s).trim()) || null;

function rad(a) {
  n.lasta++;
  const orgnr = normOrgnr(a.peOrgNr);
  if (!orgnr) return n.person++;                       // personnummer: enskild firma
  if (Number(a.aeStat) !== 1) return n.ejVerksam++;
  if (Number(a.aeTyp) === 3) return n.fiktiv++;
  const g = a.geografiskInformation ?? {};
  // Adressens läge, annars fastighetens mittpunkt.
  const [x, y] = g.ostKoordinatAdressSW > 0 ? [g.ostKoordinatAdressSW, g.nordKoordinatAdressSW] : [g.ostKoordinatSW, g.nordKoordinatSW];
  if (!(x > 0 && y > 0)) return n.utanKoord++;
  const [lon, lat] = sweref99tmToWgs84(x, y);
  const ng = [...(a.naringsgrenar ?? [])].sort((p, q) => p.rangordning - q.rangordning)[0];
  const sni = tom(ng?.naringsgren);
  const bet = fastighetVid(lon, lat);
  const b = a.belagenhetsadress ?? {};
  n.sparade++;
  const sparr = Number(a.reklamSparrTyp) === 2;   // 2 = har frånsagt sig reklam (kodtabellen)
  if (sparr) n.reklamsparr++;
  if (bet) n.kopplade++;
  if (!args.dry) {
    const ae = { sni, avdelning: tom(ng?.avdelningsKod), anstkl: a.anstKl == null ? null : Number(a.anstKl) };
    ins.run(a.cfarNr, orgnr, tom(a.ben), sni, ae.avdelning, BRANSCH.get(sni) ?? null, ae.anstkl,
      tom(b.bGatuAdress), tom(b.bPostNr), tom(b.bPostOrt), Math.round(lon * 1e6) / 1e6, Math.round(lat * 1e6) / 1e6, bet,
      lokaltyp(ae), loaM2(ae), sparr ? 1 : 0);
  }
}

// En transaktion: avbryts hämtningen ligger de gamla raderna kvar.
db.exec('BEGIN');
try {
  if (!args.dry) db.exec('DELETE FROM arbetsstalle WHERE demo = 0');
  for await (const sida of scb.sidor('/arbetsstallen/full', 'arbetsstallen', args.sidor)) {
    sida.forEach(rad);
    if (!args.fil) process.stdout.write(`\r${n.lasta.toLocaleString('sv')} lästa…`);
  }
  if (!args.dry) {
    db.exec('CREATE TABLE IF NOT EXISTS meta(nyckel TEXT PRIMARY KEY,varde TEXT)');
    if (args.sidor) db.exec("DELETE FROM meta WHERE nyckel='scb_arbetsstallen_hamtad'");
    else db.prepare("INSERT OR REPLACE INTO meta VALUES ('scb_arbetsstallen_hamtad', ?)").run(new Date().toISOString());
  }
  db.exec(args.dry ? 'ROLLBACK' : 'COMMIT');
} catch (e) {
  db.exec('ROLLBACK');
  throw e;
}

const t = (v) => v.toLocaleString('sv');
console.log(`\n${args.dry ? 'Torrkörning (inget sparat)' : 'Klart'}: ${t(n.lasta)} arbetsställen lästa, ${t(n.sparade)} sparade, `
  + `varav ${t(n.kopplade)} på en fastighet i Horos (${t(n.sparade - n.kopplade)} utan), ${t(n.reklamsparr)} med reklamspärr.\n`
  + `  Uteslutna: ${t(n.person)} enskilda firmor, ${t(n.ejVerksam)} ej verksamma, ${t(n.fiktiv)} fiktiva, `
  + `${t(n.utanKoord)} utan koordinater.`);
if (!BRANSCH.size) console.log('  Inga SNI-klartexter (ange --sni med kodtabellen).');
