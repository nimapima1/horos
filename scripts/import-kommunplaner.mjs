// Plangränser från kommunernas öppna karttjänster (lib/kommunplaner.mjs). Kör efter NGP-importen, så att planer
// som NGP redan har inte tas med två gånger.
// node scripts/import-kommunplaner.mjs --kommun alla|0126[,1280] [--dry]
import { parseArgs } from '../lib/csv.mjs';
import { openDb, rebuildRtree } from '../lib/db.mjs';
import { KALLOR, hamtaKommunplaner, sparaKommunplaner, utanNgpDubbletter } from '../lib/kommunplaner.mjs';
import { KOMMUNER } from '../lib/kommuner.mjs';

const args = parseArgs(process.argv.slice(2));
const lista = String(args.kommun ?? '');
try {
  if (lista !== 'alla' && !/^\d{4}(,\d{4})*$/.test(lista)) throw new Error('Ange --kommun alla eller kommunkoder med komma, exempelvis 0126,1280.');
  const koder = lista === 'alla' ? Object.keys(KALLOR) : lista.split(',');
  const namn = new Map(KOMMUNER);
  const db = openDb(args.dry ? { readOnly: true } : undefined);
  const fel = [];
  let antal = 0;
  try {
    for (const kod of koder) {
      try {
        const { rader, utanGeometri } = await hamtaKommunplaner(kod);
        if (!rader.length) throw new Error('inga planer i svaret, behåller det som finns');
        // Tom efter dubblettkontrollen = NGP har alla; då arkiveras kommunens tidigare rader.
        const nya = utanNgpDubbletter(db, rader, kod);
        console.log(`${kod} ${namn.get(kod) ?? ''}: ${nya.length} planer (${rader.length - nya.length} finns redan i NGP${utanGeometri ? `, ${utanGeometri} utan giltig geometri` : ''}).`);
        if (!args.dry) sparaKommunplaner(db, nya, kod);
        antal += nya.length;
      } catch (error) {
        fel.push(kod);
        console.error(`${kod} ${namn.get(kod) ?? ''}: ${error instanceof TypeError ? 'anslutningen misslyckades' : error.message}`);
      }
    }
    if (!args.dry) rebuildRtree(db, 'plan');
  } finally { db.close(); }
  console.log(`${antal} planer från ${koder.length - fel.length} kommuner.${args.dry ? ' Provkörning: databasen ändrades inte.' : ''}`);
  if (fel.length) { console.log(`Misslyckades: ${fel.join(',')}`); process.exitCode = 1; }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
