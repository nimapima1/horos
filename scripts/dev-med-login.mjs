// Startar utvecklingsservern med Geotorget-inloggning för historiska flygfoton.
// Lösenordet efterfrågas dolt och finns bara i processens minne; det sparas ingenstans.
//
//   node scripts/dev-med-login.mjs <geotorget-användarnamn>
import { promptHidden } from '../lib/prompt.mjs';

const user = process.argv[2] ?? process.env.GEOTORGET_USER;
if (!user) { console.error('Ange Geotorget-användarnamnet: node scripts/dev-med-login.mjs <användarnamn>'); process.exit(1); }

process.env.GEOTORGET_USER = user;
process.env.GEOTORGET_PASS = await promptHidden(`Geotorget-lösenord för ${user}: `);
await import('../server.mjs');
