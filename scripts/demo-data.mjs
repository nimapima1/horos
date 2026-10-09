// Fyller databasen med EXEMPELDATA så att kartan går att prova innan riktiga
// källor finns. Geometrierna är byggnader från OpenStreetMap (ODbL) i centrala
// Stockholm och används som stand-in för fastigheter. Ägare, taxeringsvärden
// och köpeskillingar är PÅHITTADE och knyts till fiktiva bolag med ogiltiga
// organisationsnummer (börjar på 00), så de kan aldrig förväxlas med verkliga.
//
//   node scripts/demo-data.mjs          lägg in exempeldata
//   node scripts/demo-data.mjs --clear  ta bort all exempeldata
import { openDb, geomBbox, withTransaction, DATA_TABLES, rebuildBolagFts } from '../lib/db.mjs';
import { innerPoints, mapCoords, planarArea } from '../lib/geo.mjs';
import { lokaltyp, loaM2 } from '../lib/lokaltyp.mjs';

const db = openDb();

function clearDemo() {
  for (const t of DATA_TABLES) db.exec(`DELETE FROM ${t} WHERE demo = 1`);
}

if (process.argv.includes('--clear')) {
  clearDemo();
  rebuildBolagFts(db);
  console.log('Exempeldata borttagen.');
  process.exit(0);
}

// Norrmalm/City, ungefär Hötorget–Kungsträdgården.
const BBOX = [59.3295, 18.0520, 59.3390, 18.0760]; // syd, väst, nord, öst
const query = `[out:json][timeout:60];way["building"](${BBOX.join(',')});out geom;`;
console.log('Hämtar byggnader från OpenStreetMap (Overpass)…');
const res = await fetch('https://overpass-api.de/api/interpreter', {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': 'fastighetskarta-prototyp/0.1' },
  body: new URLSearchParams({ data: query }),
});
if (!res.ok) throw new Error(`Overpass svarade ${res.status}`);
const osm = await res.json();

// Deterministisk slump så att demon ser likadan ut varje gång.
let seed = 42;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];

const BOLAG = [
  ['0020000001', 'Exempel Fastigheter AB', 'Aktiebolag', '68201'],
  ['0020000002', 'Demo Kontorshus AB', 'Aktiebolag', '68203'],
  ['0020000003', 'Påhittade Handelsplatser AB', 'Aktiebolag', '68203'],
  ['0020000004', 'Fiktiv Förvaltning Holding AB', 'Aktiebolag', '64202'],
  ['0020000005', 'Testkvarteret Kommanditbolag', 'Kommanditbolag', '68203'],
  ['0020000006', 'Exempelstadens Bostads AB', 'Aktiebolag', '68201'],
];

// Ytberäkning i m² via lokal ekvirektangulär projektion.
function areaM2(ring) {
  const kx = 111320 * Math.cos((ring[0][1] * Math.PI) / 180), ky = 110540;
  return planarArea(mapCoords({ type: 'Polygon', coordinates: [ring] }, ([x, y]) => [x * kx, y * ky]));
}

const insBolag = db.prepare(`INSERT OR REPLACE INTO bolag (orgnr, namn, jurform, status, sni, adress, postnr, postort, registrerad, verksamhet, demo)
  VALUES (?, ?, ?, '1', ?, 'Exempelgatan 1', '11111', 'STOCKHOLM', '2001-01-01', 'Påhittat bolag för exempeldata.', 1)`);
const insF = db.prepare(`INSERT OR REPLACE INTO fastighet (beteckning, kommun, areal_m2, geojson, minx, miny, maxx, maxy, kalla, demo)
  VALUES (?, 'Stockholm', ?, ?, ?, ?, ?, ?, 'demo', 1)`);
const insT = db.prepare(`INSERT INTO taxering (beteckning, taxeringsenhet, typ, ar, varde_tkr, markvarde_tkr, byggvarde_tkr, agare_orgnr, andel, demo)
  VALUES (?, ?, ?, 2025, ?, ?, ?, ?, '1/1', 1)`);
const insA = db.prepare(`INSERT INTO agande (beteckning, orgnr, andel, inskrivningsdag, tomtratt, demo) VALUES (?, ?, '1/1', ?, ?, 1)`);
const insX = db.prepare(`INSERT INTO transaktion (beteckning, inskrivningsdag, kopeskilling_kr, forvarvare_orgnr, art, andel, demo)
  VALUES (?, ?, ?, ?, 'Köp', '1/1', 1)`);

// Påhittade företag med arbetsställen i husen (som SCB:s företagsregister) och deras branscher.
const FORETAG = [
  ['0030000001', 'Exempel Konsult AB', '70220', 'N', 'Konsultverksamhet avseende företags organisation'],
  ['0030000002', 'Demo Data AB', '62100', 'K', 'Dataprogrammering'],
  ['0030000003', 'Påhittat Mode AB', '47710', 'G', 'Detaljhandel med kläder'],
  ['0030000004', 'Testkrogen AB', '56110', 'I', 'Restaurangverksamhet'],
  ['0030000005', 'Fiktiv Redovisning AB', '69201', 'N', 'Redovisning och bokföring'],
  ['0030000006', 'Exempelgrossisten AB', '46900', 'G', 'Icke specialiserad partihandel'],
  ['0030000007', 'Demovårdcentralen AB', '86211', 'R', 'Allmän öppen läkarvård'],
  ['0030000008', 'Påhittade Banken AB', '64190', 'L', 'Övrig monetär finansförmedling'],
];
const insAE = db.prepare(`INSERT INTO arbetsstalle (cfar, orgnr, benamning, sni, avdelning, bransch, anstkl, adress, postnr, ort, lon, lat, beteckning, lokaltyp, loa_m2, demo)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, '11111', 'STOCKHOLM', ?, ?, ?, ?, ?, 1)`);

const insP = db.prepare(`INSERT INTO plan (id, typ, planid, namn, datum, kommun, geojson, minx, miny, maxx, maxy, demo)
  VALUES (?, ?, ?, ?, ?, 'Stockholm', ?, ?, ?, ?, ?, 1)`);

const date = (y0, y1) => {
  const y = y0 + Math.floor(rnd() * (y1 - y0 + 1));
  return `${y}-${String(1 + Math.floor(rnd() * 12)).padStart(2, '0')}-${String(1 + Math.floor(rnd() * 28)).padStart(2, '0')}`;
};

let n = 0;
withTransaction(db, () => {
  clearDemo();
  for (const [orgnr, namn, form, sni] of BOLAG) insBolag.run(orgnr, namn, form, sni);
  for (const [orgnr, namn, sni] of FORETAG) insBolag.run(orgnr, namn, 'Aktiebolag', sni);
  let cfar = 90000000;
  for (const el of osm.elements) {
    if (el.type !== 'way' || !el.geometry || el.geometry.length < 4) continue;
    const ring = el.geometry.map((p) => [p.lon, p.lat]);
    const area = areaM2(ring);
    if (area < 150) continue;                       // hoppa över bodar och smådelar
    const geom = { type: 'Polygon', coordinates: [ring] };
    const bb = geomBbox(geom);
    const bet = `EXEMPEL ${Math.floor(n / 9) + 1}:${(n % 9) + 1}`;
    insF.run(bet, Math.round(area), JSON.stringify(geom), bb.minx, bb.miny, bb.maxx, bb.maxy);

    const agare = pick(BOLAG)[0];
    const varde = Math.round(area * (25 + rnd() * 70));            // tkr
    const mark = Math.round(varde * (0.3 + rnd() * 0.3));
    insT.run(bet, `9${String(100000 + n).slice(1)}`, pick(['Hyreshusenhet, lokaler', 'Hyreshusenhet, bostäder och lokaler', 'Hyreshusenhet, bostäder']),
      varde, mark, varde - mark, agare);
    const forvarv = date(2001, 2025);
    insA.run(bet, agare, forvarv, rnd() < 0.2 ? 1 : 0);   // ungefär var femte med tomträtt
    if (rnd() < 0.35) insX.run(bet, forvarv, Math.round(varde * 1000 * (1.1 + rnd() * 0.6)), agare);
    // Ungefär två av tre hus har 1–4 företag, på en eller två adresser.
    if (rnd() < 0.65) {
      const pt = innerPoints(geom, 3)[0], gata = `Exempelgatan ${n + 1}`;
      for (let i = Math.floor(1 + rnd() * 4); i > 0; i--) {
        const [orgnr, namn, sni, avd, bransch] = pick(FORETAG);
        const ae = { sni, avdelning: avd, anstkl: Math.floor(1 + rnd() * 7) };
        insAE.run(cfar++, orgnr, rnd() < 0.2 ? `${namn.replace(/ AB$/, '')} City` : null, sni, avd, bransch,
          ae.anstkl, rnd() < 0.3 ? `${gata}A` : gata, pt[0], pt[1], bet, lokaltyp(ae), loaM2(ae));
      }
    }
    if (rnd() < 0.15) insX.run(bet, date(1995, 2000), Math.round(varde * 1000 * (0.4 + rnd() * 0.3)), pick(BOLAG)[0]);
    n++;
  }
  // Påhittade planer: ett rutnät av rektanglar över området, plus en nyare plan tvärs över
  // några av dem (som när en detaljplan ersätter delar av äldre stadsplaner).
  const [syd, vast, nord, ost] = BBOX, cols = 4, rows = 3;
  const rect = (x0, y0, x1, y1) => ({ type: 'Polygon', coordinates: [[[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]] });
  const plan = (id, typ, namn, datum, geom) => {
    const bb = geomBbox(geom);
    insP.run(id, typ, `EXEMPEL-${id}`, namn, datum, JSON.stringify(geom), bb.minx, bb.miny, bb.maxx, bb.maxy);
  };
  for (let i = 0; i < cols; i++) for (let j = 0; j < rows; j++) {
    const x0 = vast + ((ost - vast) * i) / cols, y0 = syd + ((nord - syd) * j) / rows;
    plan(`P${i}${j}`, pick(['SPL', 'SPL', 'DP', 'BPL']), `Exempelkvarteren ${i * rows + j + 1}`, date(1931, 1990),
      rect(x0, y0, x0 + (ost - vast) / cols, y0 + (nord - syd) / rows));
  }
  plan('PNY', 'DP', 'Exempelstråket', date(2015, 2024), rect(vast + (ost - vast) * 0.3, syd + (nord - syd) * 0.4, vast + (ost - vast) * 0.7, syd + (nord - syd) * 0.55));
});
rebuildBolagFts(db);   // så att exempelbolagen hittas i sökningen
console.log(`Klart: ${n} exempelfastigheter i centrala Stockholm. Ta bort dem med --clear.`);
