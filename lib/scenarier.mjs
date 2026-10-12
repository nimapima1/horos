// Besökarnas sparade scenarier (korta länkar) i en egen databas: den publika är skrivskyddad och byts vid publicering.
// Ingen inloggning: id:t är en hash av innehållet, så ett sparat scenario ändras aldrig och samma innehåll ger samma
// länk. Servern (server.mjs) väljer filen: på servern i systemds STATE_DIRECTORY (StateDirectory=horos-scenarion).
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const MAX_SCENARIO = 1000;            // fastigheter per scenario (och rader i en fil som läses in)
export const MAX_SCENARIO_BYTE = 256 * 1024;
const MAX_SCENARIER = 200_000;               // skydd mot att disken fylls

// Lagringen i filen path: { hamta(id) -> JSON-text eller null, spara(scenario) -> id, eller null om lagringen är
// full }. null om path saknas eller inte går att skriva; då är korta länkar avstängda och klienten lägger
// scenariot i länken i stället.
export function oppnaScenarier(path) {
  if (!path) return null;
  try {
    mkdirSync(dirname(path), { recursive: true });
    const sdb = new DatabaseSync(path);
    sdb.exec(`PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS scenario (id TEXT PRIMARY KEY, data TEXT NOT NULL, skapad TEXT NOT NULL) WITHOUT ROWID`);
    const antal = sdb.prepare('SELECT count(*) AS n FROM scenario');
    const infoga = sdb.prepare("INSERT OR IGNORE INTO scenario (id, data, skapad) VALUES (?, ?, date('now'))");
    const las = sdb.prepare('SELECT data FROM scenario WHERE id = ?');
    return {
      hamta: (id) => las.get(id)?.data ?? null,
      spara(scenario) {
        const data = JSON.stringify(scenario);
        const id = createHash('sha256').update(data).digest('base64url').slice(0, 10);
        if (!las.get(id)) {
          if (antal.get().n >= MAX_SCENARIER) return null;
          infoga.run(id, data);
        }
        return id;
      },
    };
  } catch (e) {
    console.error(`Korta länkar är avstängda (${path}): ${e.message}`);
    return null;
  }
}

// Scenariot tolkas aldrig av servern, men ska vara det klienten skickar: bara objekt, listor, korta strängar, tal och
// null, inte för djupt (delar[i].egna[bet].yta[slag] är det djupaste), med fastigheterna i bet.
const giltigt = (v, djup = 0) => v === null || (typeof v === 'number' && Number.isFinite(v))
  || (typeof v === 'string' && v.length <= 100)
  || (djup < 6 && typeof v === 'object' && Object.keys(v).length <= MAX_SCENARIO
    && Object.entries(v).every(([k, x]) => k.length <= 100 && giltigt(x, djup + 1)));
export const giltigtScenario = (s) => s?.v === 1 && Array.isArray(s.bet) && s.bet.length <= MAX_SCENARIO && giltigt(s);
