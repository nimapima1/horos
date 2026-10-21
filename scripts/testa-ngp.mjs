// Provar NGP-behörigheten utan att lagra data eller inloggningsuppgifter.
// Kör: node scripts/testa-ngp.mjs <Geotorget-användarnamn>
import { pathToFileURL } from 'node:url';
import { promptHidden } from '../lib/prompt.mjs';
import { NGP_URL } from '../lib/ngp.mjs';

export async function testaNgp(user, password, request = fetch) {
  const response = await request(new URL('collections', NGP_URL).href, {
    headers: { Authorization: `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`, Accept: 'application/json' },
    redirect: 'error',
    signal: AbortSignal.timeout(30_000),
  });
  if (response.status === 401) throw new Error('Inloggningen nekades. Kontrollera Geotorget-uppgifterna och att NGP är aktiverat.');
  if (response.status === 403) throw new Error('Kontot saknar behörighet. Godkänn NGP:s användningsvillkor i Geotorget.');
  if (!response.ok) throw new Error(`NGP svarade med HTTP ${response.status}. Försök igen senare.`);
  const data = await response.json();
  if (!Array.isArray(data.collections)) throw new Error('NGP gav ett oväntat svar utan samlingar.');
  return data.collections.length;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const user = process.argv[2] || process.env.GEOTORGET_USER;
    if (!user) throw new Error('Ange användarnamnet: node scripts/testa-ngp.mjs <Geotorget-användarnamn>');
    const password = process.env.GEOTORGET_PASS || await promptHidden('Geotorget-lösenord: ');
    const count = await testaNgp(user, password);
    console.log(`Anslutningen fungerar. NGP ger tillgång till ${count} samlingar för detaljplaner.`);
  } catch (error) {
    console.error(error instanceof TypeError ? 'Kunde inte ansluta till NGP. Kontrollera nätverksanslutningen.' : error.message);
    process.exitCode = 1;
  }
}
