// node scripts/import-ngp.mjs --kommun 0180 --user <Geotorget-användarnamn> [--dry]
import { parseArgs } from '../lib/csv.mjs';
import { openDb, rebuildRtree } from '../lib/db.mjs';
import { promptHidden } from '../lib/prompt.mjs';
import { hamtaNgp, hamtaPlanDokument, ngpPlaner, sparaNgp } from '../lib/ngp.mjs';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from '../lib/db.mjs';

const args = parseArgs(process.argv.slice(2));
try {
  if (!/^\d{4}$/.test(args.kommun ?? '')) throw new Error('Ange fyrsiffrig kommunkod med --kommun, exempelvis 0180.');
  let features;
  let password;
  const user = args.user || process.env.GEOTORGET_USER;
  if (!args.fil || args.dokument) {
    if (!user) throw new Error('Ange Geotorget-användarnamnet med --user.');
    password = process.env.GEOTORGET_PASS || await promptHidden('Geotorget-lösenord: ');
  }
  if (args.fil) features = JSON.parse(readFileSync(args.fil, 'utf8'));
  else {
    features = await hamtaNgp(args.kommun, user, password);
  }
  if (args.dokument) {
    console.log('Hämtar dokumentadresser och PDF-filer från NGP. Inloggningen skickas bara till Lantmäteriet.');
    let dokumentFel;
    try { await hamtaPlanDokument(features, user, password); }
    catch (error) { dokumentFel = error; }
    const cache = join(ROOT, 'data', 'raw', `ngp-${args.kommun}-dokument-${Date.now()}.json`);
    mkdirSync(join(ROOT, 'data', 'raw'), { recursive: true });
    writeFileSync(cache, JSON.stringify(features), { flag: 'wx' });
    console.log(`Svar med dokumentadresser sparat i ${cache}.`);
    if (dokumentFel) throw dokumentFel;
  }
  let planer;
  try { planer = ngpPlaner(features, args.kommun); }
  catch (error) {
    if (!args.fil) {
      const dir = join(ROOT, 'data', 'raw');
      mkdirSync(dir, { recursive: true });
      const file = join(dir, `ngp-${args.kommun}-${Date.now()}.json`);
      writeFileSync(file, JSON.stringify(features), { flag: 'wx' });
      console.error(`NGP-svaret sparades för felsökning i ${file}. Inga inloggningsuppgifter finns i filen. Databasen ändrades inte.`);
    }
    throw error;
  }
  const gallande = planer.filter((p) => p.status === 'laga kraft').length;
  console.log(`${planer.length} planer hämtade för ${args.kommun}, varav ${gallande} med laga kraft.`);
  console.log(`${features.length - planer.length} planbestämmelser hämtade.`);
  if (args.dry) console.log('Provkörning: databasen ändrades inte. Eventuella dokument och felsökningsfiler sparas lokalt.');
  else {
    const db = openDb();
    try {
      sparaNgp(db, planer, args.kommun); rebuildRtree(db, 'plan');
    }
    finally { db.close(); }
    console.log('Import klar. Horos visar gällande och pågående planer med status. Upphävda, avslutade och arkiverade planer behålls i arbetsdatabasen.');
  }
} catch (error) {
  console.error(error instanceof TypeError ? 'Anslutningen till NGP misslyckades. Kontrollera nätverket.' : error.message);
  process.exitCode = 1;
}
