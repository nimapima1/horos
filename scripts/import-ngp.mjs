// node scripts/import-ngp.mjs --kommun 0180 --user <Geotorget-användarnamn> [--dry]
// Flera kommuner: --kommun 0180,1380, eller --kommun alla (varje samling i NGP). Fel i en kommun stoppar inte de andra.
import { parseArgs } from '../lib/csv.mjs';
import { openDb, rebuildRtree } from '../lib/db.mjs';
import { promptHidden } from '../lib/prompt.mjs';
import { hamtaNgp, hamtaPlanDokument, ngpKommuner, ngpPlaner, sparaNgp } from '../lib/ngp.mjs';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from '../lib/db.mjs';

const args = parseArgs(process.argv.slice(2));
const lista = String(args.kommun ?? '');
const flera = lista === 'alla' || lista.includes(',');
let user, password;

async function importera(kommun, db) {
  let features;
  if (args.fil) features = JSON.parse(readFileSync(args.fil, 'utf8'));
  else {
    features = await hamtaNgp(kommun, user, password);
  }
  if (args.dokument) {
    console.log('Hämtar dokumentadresser och PDF-filer från NGP. Inloggningen skickas bara till Lantmäteriet.');
    let dokumentFel;
    try { await hamtaPlanDokument(features, user, password); }
    catch (error) { dokumentFel = error; }
    const cache = join(ROOT, 'data', 'raw', `ngp-${kommun}-dokument-${Date.now()}.json`);
    mkdirSync(join(ROOT, 'data', 'raw'), { recursive: true });
    writeFileSync(cache, JSON.stringify(features), { flag: 'wx' });
    console.log(`Svar med dokumentadresser sparat i ${cache}.`);
    if (dokumentFel) throw dokumentFel;
  }
  let planer;
  try { planer = ngpPlaner(features, kommun); }
  catch (error) {
    if (!args.fil) {
      const dir = join(ROOT, 'data', 'raw');
      mkdirSync(dir, { recursive: true });
      const file = join(dir, `ngp-${kommun}-${Date.now()}.json`);
      writeFileSync(file, JSON.stringify(features), { flag: 'wx' });
      console.error(`NGP-svaret sparades för felsökning i ${file}. Inga inloggningsuppgifter finns i filen. Databasen ändrades inte för ${kommun}.`);
    }
    throw error;
  }
  const gallande = planer.filter((p) => p.status === 'laga kraft').length;
  console.log(`${kommun}: ${planer.length} planer hämtade, varav ${gallande} med laga kraft, och ${features.length - planer.length} planbestämmelser.`);
  if (db) sparaNgp(db, planer, kommun);
  return planer.length;
}

try {
  if (lista !== 'alla' && !/^\d{4}(,\d{4})*$/.test(lista)) throw new Error('Ange --kommun med fyrsiffrig kommunkod (0180), flera med komma (0180,1380) eller alla.');
  if (flera && (args.fil || args.dokument)) throw new Error('--fil och --dokument fungerar bara för en kommun i taget.');
  user = args.user || process.env.GEOTORGET_USER;
  if (!args.fil || args.dokument) {
    if (!user) throw new Error('Ange Geotorget-användarnamnet med --user.');
    password = process.env.GEOTORGET_PASS || await promptHidden('Geotorget-lösenord: ');
  }
  const kommuner = lista === 'alla' ? (await ngpKommuner(user, password)).filter((id) => /^\d{4}$/.test(id)) : lista.split(',');
  const db = args.dry ? null : openDb();
  const start = Date.now(), fel = [];
  let antal = 0;
  try {
    for (const [i, kommun] of kommuner.entries()) {
      if (flera) process.stdout.write(`[${i + 1}/${kommuner.length}] `);
      try { antal += await importera(kommun, db); }
      catch (error) {
        if (!flera) throw error;
        fel.push(kommun);
        console.error(`${kommun}: ${error instanceof TypeError ? 'anslutningen misslyckades' : error.message.split('\n')[0]}`);
      }
    }
    if (db) rebuildRtree(db, 'plan');
  } finally { db?.close(); }
  if (flera) {
    console.log(`${antal} planer från ${kommuner.length - fel.length} kommuner på ${Math.round((Date.now() - start) / 60000)} min.`);
    if (fel.length) console.log(`Misslyckades (kör om med --kommun ${fel.join(',')}): ${fel.join(', ')}`);
  }
  if (args.dry) console.log('Provkörning: databasen ändrades inte. Eventuella dokument och felsökningsfiler sparas lokalt.');
  else console.log('Import klar. Horos visar gällande och pågående planer med status. Upphävda, avslutade och arkiverade planer behålls i arbetsdatabasen.');
  if (fel.length) process.exitCode = 1;
} catch (error) {
  console.error(error instanceof TypeError ? 'Anslutningen till NGP misslyckades. Kontrollera nätverket.' : error.message);
  process.exitCode = 1;
}
