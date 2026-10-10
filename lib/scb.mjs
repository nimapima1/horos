// SCB:s företagsregister (avgiftsfritt API, https://apiafr.scb.se/v1). Nyckeln är personlig: den läses
// från miljövariabeln SCB_API_KEY eller efterfrågas utan att visas, och sparas aldrig.
import { promptHidden } from './prompt.mjs';

const BAS = 'https://apiafr.scb.se/v1';
const LIMIT = 5000;     // högsta antal rader per anrop
const PAUS_MS = 250;    // SCB tillåter 5 anrop per sekund och nyckel
const vanta = (ms) => new Promise((r) => setTimeout(r, ms));

export async function scbKlient() {
  const nyckel = process.env.SCB_API_KEY || await promptHidden('SCB API-nyckel: ');
  if (!/^[!-~]+$/.test(nyckel)) throw new Error('API-nyckeln är tom eller har ogiltiga tecken. Klistra in med högerklick och tryck Enter.');

  // Pausen före varje anrop håller hastighetsgränsen för alla anropare.
  async function hamta(path) {
    for (let forsok = 1; ; forsok++) {
      await vanta(PAUS_MS);
      const res = await fetch(BAS + path, { headers: { 'X-API-Key': nyckel, accept: 'application/json' } });
      if (res.ok) return res.json();
      // 429: för många anrop; 503: nattlig uppdatering 04:00–04:30. Vänta och försök igen.
      if ((res.status === 429 || res.status === 503) && forsok < 6) { await vanta(forsok * 10_000); continue; }
      throw new Error(`SCB svarade ${res.status} på ${path}: ${(await res.text()).slice(0, 200)}`);
    }
  }

  // En lista (t.ex. /arbetsstallen/full) sida för sida, så att hela landet aldrig ligger i minnet.
  // falt: listans namn i svaret; maxSidor: stanna efter så många sidor (för att prova).
  async function* sidor(path, falt, maxSidor) {
    let cursor = null;
    for (let sida = 1; ; sida++) {
      const s = await hamta(`${path}?limit=${LIMIT}${cursor != null ? `&cursorId=${cursor}` : ''}`);
      yield s[falt] ?? [];
      if (!s.pagination?.hasMore || sida === Number(maxSidor)) return;
      cursor = s.pagination.nextCursorId;
    }
  }

  return { hamta, sidor };
}
