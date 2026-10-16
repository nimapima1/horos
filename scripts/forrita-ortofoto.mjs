// Ritar flygfotorutor i förväg genom att hämta dem från den egna servern, som ritar och sparar dem i
// cachen. Rutor som redan finns går fort. Standard: Stockholms kommun, zoom 14–17 (~36 000 rutor).
//
//   node scripts/forrita-ortofoto.mjs [--bbox 17.75,59.22,18.21,59.45] [--zoom 14-17]
//                                     [--url http://127.0.0.1:3000] [--samtidigt 3]
//
// Få samtidiga hämtningar lämnar arbetare lediga åt besökarna; ett 503 (kön full) väntas ut.
import { parseArgs } from '../lib/csv.mjs';

const args = parseArgs(process.argv.slice(2));
const [minLon, minLat, maxLon, maxLat] = String(args.bbox ?? '17.75,59.22,18.21,59.45').split(',').map(Number);
const [zMin, zMax] = String(args.zoom ?? '14-17').split('-').map(Number);
const url = String(args.url ?? 'http://127.0.0.1:3000');
const samtidigt = Number(args.samtidigt ?? 3);
if (![minLon, minLat, maxLon, maxLat, zMin, zMax].every(Number.isFinite) || zMax > 18) {
  console.error('Kontrollera --bbox minLon,minLat,maxLon,maxLat och --zoom från-till (högst 18).');
  process.exit(1);
}

const rutX = (lon, z) => Math.floor(((lon + 180) / 360) * 2 ** z);
const rutY = (lat, z) => Math.floor(((1 - Math.asinh(Math.tan((lat * Math.PI) / 180)) / Math.PI) / 2) * 2 ** z);
function* rutor() {
  for (let z = zMin; z <= zMax; z++) {
    for (let x = rutX(minLon, z); x <= rutX(maxLon, z); x++) {
      for (let y = rutY(maxLat, z); y <= rutY(minLat, z); y++) yield `${z}/${x}/${y}`;
    }
  }
}
let totalt = 0;
for (let z = zMin; z <= zMax; z++) totalt += (rutX(maxLon, z) - rutX(minLon, z) + 1) * (rutY(minLat, z) - rutY(maxLat, z) + 1);
console.log(`${totalt} rutor, zoom ${zMin}–${zMax}, ${samtidigt} åt gången.`);

const start = Date.now();
const antal = { klara: 0, saknas: 0, fel: 0 };
const ko = rutor();
async function arbeta() {
  for (const ruta of ko) {
    for (let forsok = 1; ; forsok++) {
      const r = await fetch(`${url}/tiles/ortofoto/${ruta}.webp`).catch((err) => ({ status: 0, err }));
      await r.arrayBuffer?.().catch(() => {});
      if (r.status === 200) { antal.klara++; break; }
      if (r.status === 404) { antal.saknas++; break; }   // inget ortofoto där (vatten utanför täckningen)
      if ((r.status === 503 || r.status === 429) && forsok < 20) { await new Promise((ok) => setTimeout(ok, 5000)); continue; }
      antal.fel++;
      console.error(`${ruta}: ${r.status || r.err?.message}`);
      break;
    }
    const n = antal.klara + antal.saknas + antal.fel;
    if (n % 1000 === 0) console.log(`${n}/${totalt} (${Math.round((Date.now() - start) / 60000)} min)`);
  }
}
await Promise.all(Array.from({ length: samtidigt }, arbeta));
console.log(`Klart på ${Math.round((Date.now() - start) / 60000)} min: ${antal.klara} rutor, ${antal.saknas} utan ortofoto, ${antal.fel} fel.`);
process.exit(antal.fel ? 1 : 0);
