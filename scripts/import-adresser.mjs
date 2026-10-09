// Importerar adresspunkter för Stockholms kommun från OpenStreetMap (ODbL, källa anges på
// sidan) till tabellen adress, och bygger sökindexet. Ersätts av Lantmäteriets
// belägenhetsadresser när den ansökan är beviljad; sökningen fungerar likadant.
//
//   node scripts/import-adresser.mjs [--fil overpass.json]   (--fil: använd en sparad hämtning)
import { readFileSync } from 'node:fs';
import { openDb, rebuildAdressFts, withTransaction } from '../lib/db.mjs';
import { parseArgs } from '../lib/csv.mjs';

const args = parseArgs(process.argv.slice(2));

// Rektangel över Stockholms kommun (med kanter av grannkommunerna); en områdesfråga är för
// tung för den publika Overpass-servern. Byggnader och punkter med husnummer.
const BBOX = '59.22,17.75,59.44,18.21';
const QUERY = `[out:json][timeout:240];
(node["addr:housenumber"]["addr:street"](${BBOX}); way["addr:housenumber"]["addr:street"](${BBOX}););
out center tags;`;

let osm;
if (args.fil) {
  osm = JSON.parse(readFileSync(args.fil, 'utf8'));
} else {
  console.log('Hämtar adresser för Stockholms kommun från OpenStreetMap (Overpass)…');
  const res = await fetch('https://overpass-api.de/api/interpreter', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': 'horos/0.1 (ideell fastighetskarta)' },
    body: new URLSearchParams({ data: QUERY }),
  });
  if (!res.ok) throw new Error(`Overpass svarade ${res.status}`);
  osm = await res.json();
}

// En adress per gata + nummer (+ postnummer); dubbletter (nod och byggnad) slås ihop.
const seen = new Set();
const rows = [];
for (const el of osm.elements) {
  const t = el.tags ?? {};
  const lon = el.lon ?? el.center?.lon, lat = el.lat ?? el.center?.lat;
  if (lon == null || !t['addr:street'] || !t['addr:housenumber']) continue;
  for (const nummer of t['addr:housenumber'].split(/[;,]/).map((s) => s.trim()).filter(Boolean)) {
    const postnr = t['addr:postcode']?.replace(/\s/g, '') || null;
    const key = `${t['addr:street']}|${nummer}|${postnr}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push([t['addr:street'], nummer, postnr, t['addr:city'] ?? null, lon, lat]);
  }
}

const db = openDb();
const ins = db.prepare("INSERT INTO adress (gata, nummer, postnr, ort, lon, lat, kalla) VALUES (?, ?, ?, ?, ?, ?, 'osm')");
withTransaction(db, () => {
  db.exec("DELETE FROM adress WHERE kalla = 'osm'");
  for (const r of rows) ins.run(...r);
});
rebuildAdressFts(db);
console.log(`Klart: ${rows.length.toLocaleString('sv')} adresser i Stockholmsområdet (av ${osm.elements.length.toLocaleString('sv')} OSM-objekt).`);
