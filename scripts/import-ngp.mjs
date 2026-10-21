// node scripts/import-ngp.mjs --kommun 0180 --user <Geotorget-användarnamn> [--dry]
import { parseArgs } from '../lib/csv.mjs';
import { openDb, rebuildRtree } from '../lib/db.mjs';
import { promptHidden } from '../lib/prompt.mjs';
import { hamtaNgp, ngpPlan, sparaNgp } from '../lib/ngp.mjs';

const args = parseArgs(process.argv.slice(2));
try {
  if (!/^\d{4}$/.test(args.kommun ?? '')) throw new Error('Ange fyrsiffrig kommunkod med --kommun, exempelvis 0180.');
  const user = args.user || process.env.GEOTORGET_USER;
  if (!user) throw new Error('Ange Geotorget-användarnamnet med --user.');
  const password = process.env.GEOTORGET_PASS || await promptHidden('Geotorget-lösenord: ');
  const features = await hamtaNgp(args.kommun, user, password);
  const planer = features.map((f) => ngpPlan(f, args.kommun));
  const gallande = planer.filter((p) => p.status === 'laga kraft').length;
  console.log(`${planer.length} planer hämtade för ${args.kommun}, varav ${gallande} med laga kraft.`);
  if (args.dry) console.log('Provkörning: inget sparades.');
  else {
    const db = openDb();
    try { sparaNgp(db, planer, args.kommun); rebuildRtree(db, 'plan'); }
    finally { db.close(); }
    console.log('Import klar. Horos visar gällande och pågående planer med status. Upphävda, avslutade och arkiverade planer behålls i arbetsdatabasen.');
  }
} catch (error) {
  console.error(error instanceof TypeError ? 'Anslutningen till NGP misslyckades. Kontrollera nätverket.' : error.message);
  process.exitCode = 1;
}
