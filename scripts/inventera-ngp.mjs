// Räknar NGP:s detaljplaner per kommun utan att skriva databasen. Resultat: data/planer-kommuner/ngp-tackning.csv.
// Kör: node scripts/inventera-ngp.mjs --user <Geotorget-användarnamn> [--kommun 0180]
import { pathToFileURL } from 'node:url';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from '../lib/csv.mjs';
import { ROOT } from '../lib/db.mjs';
import { promptHidden } from '../lib/prompt.mjs';
import { KOMMUNER } from '../lib/kommuner.mjs';
import { hamtaNgp, ngpKommuner } from '../lib/ngp.mjs';

const BARA_PLANER = { 'feature.typ': { eq: 'detaljplan' } };

export function rakna(features) {
  const r = { planer: 0, laga_kraft: 0, pagaende: 0, ovriga: 0, aldsta: '', senaste: '' };
  for (const f of features) {
    const p = f.properties?.detaljplan;
    if (f.properties?.feature?.typ !== 'detaljplan' || !p) continue;
    r.planer++;
    if (p.status === 'laga kraft') r.laga_kraft++;
    else if (['påbörjad', 'samråd', 'granskning', 'antagen', 'överklagad', 'tillsyn'].includes(p.status)) r.pagaende++;
    else r.ovriga++;
    const d = p.datumLagakraft?.slice(0, 10);
    if (d && (!r.aldsta || d < r.aldsta)) r.aldsta = d;
    if (d && d > r.senaste) r.senaste = d;
  }
  return r;
}

export async function inventeraNgp(user, password, request = fetch, bara) {
  const ids = await ngpKommuner(user, password, request);
  const koder = ids.filter((id) => /^\d{4}$/.test(id) && (!bara || id === bara));
  const rader = [];
  for (const kod of koder) {
    try { rader.push({ kod, ...rakna(await hamtaNgp(kod, user, password, request, BARA_PLANER)) }); }
    catch (error) { rader.push({ kod, fel: error.message.split('\n')[0] }); }
    process.stdout.write(`\r${rader.length}/${koder.length} kommuner`);
  }
  process.stdout.write('\n');
  return { rader, andra: ids.filter((id) => !/^\d{4}$/.test(id)) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const user = args.user || process.env.GEOTORGET_USER;
    if (!user) throw new Error('Ange användarnamnet: node scripts/inventera-ngp.mjs --user <Geotorget-användarnamn>');
    const password = process.env.GEOTORGET_PASS || await promptHidden('Geotorget-lösenord: ');
    const { rader, andra } = await inventeraNgp(user, password, fetch, args.kommun);
    const namn = new Map(KOMMUNER);
    const f = ['kod', 'kommun', 'planer', 'laga_kraft', 'pagaende', 'ovriga', 'aldsta', 'senaste', 'fel'];
    const dir = join(ROOT, 'data', 'planer-kommuner');
    mkdirSync(dir, { recursive: true });
    const fil = join(dir, 'ngp-tackning.csv');
    writeFileSync(fil, '﻿' + [f.join(';'), ...rader.map((r) => f.map((k) => k === 'kommun' ? namn.get(r.kod) ?? '' : r[k] ?? '').join(';'))].join('\r\n') + '\r\n');
    const ok = rader.filter((r) => !r.fel);
    console.log(`${ok.filter((r) => r.planer).length} av ${rader.length} kommuner har planer i NGP, totalt ${ok.reduce((s, r) => s + r.planer, 0)}.`);
    if (rader.some((r) => r.fel)) console.log(`${rader.filter((r) => r.fel).length} kommuner gav fel, se kolumnen fel.`);
    if (andra.length) console.log(`Samlingar som inte är kommunkoder: ${andra.join(', ')}`);
    console.log(`Sparat i ${fil}. Databasen ändrades inte.`);
  } catch (error) {
    console.error(error instanceof TypeError ? 'Kunde inte ansluta till NGP. Kontrollera nätverksanslutningen.' : error.message);
    process.exitCode = 1;
  }
}
