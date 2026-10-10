// Läser ägarkontrollen ur SCB:s företagsregister (fältet agKat) till bolag.agarkontroll, för alla bolag
// som redan finns i tabellen (import-bolag). Ägarkategorin på kartan använder den, så att t.ex. kommunala
// bostadsbolag räknas som Kommun.
//
//   node scripts/import-agarkontroll.mjs [--dry] [--sidor N]
//   node scripts/import-agarkontroll.mjs --fil sidor.json [--dry]
//
// Hämtar /v1/juridiskaenheter/full för hela landet (några hundra anrop). Nyckeln: se lib/scb.mjs.
// --sidor N: bara de N första sidorna (5 000 per sida). --fil: sparade svar ({jes: [...]}) i stället för API:t.
import { openDb, normOrgnr } from '../lib/db.mjs';
import { parseArgs } from '../lib/csv.mjs';
import { scbKlient } from '../lib/scb.mjs';

const args = parseArgs(process.argv.slice(2));
// SCB:s koder (kodtabellen agarkontrollkoder) -> värdet i bolag.agarkontroll.
const AGARKONTROLL = { 10: 'stat', 20: 'kommun', 30: 'region', 41: 'privat', 42: 'privat_koncern', 50: 'utland' };
const scb = await scbKlient({ fil: args.fil });

const db = openDb();
const upd = db.prepare('UPDATE bolag SET agarkontroll = ? WHERE orgnr = ?');
const n = { lasta: 0, person: 0, uppdaterade: 0, saknas: 0, perVarde: {} };

// En transaktion; torrkörningen gör samma sak och rullar tillbaka, så att siffrorna stämmer.
db.exec('BEGIN');
try {
  for await (const sida of scb.sidor('/juridiskaenheter/full', 'jes', args.sidor)) {
    for (const e of sida) {
      n.lasta++;
      const orgnr = normOrgnr(e.peOrgNr);
      if (!orgnr) { n.person++; continue; }   // personnummer: enskild firma
      const varde = AGARKONTROLL[e.agKat] ?? null;
      if (!upd.run(varde, orgnr).changes) { n.saknas++; continue; }
      n.uppdaterade++;
      n.perVarde[varde] = (n.perVarde[varde] ?? 0) + 1;
    }
    if (!args.fil) process.stdout.write(`\r${n.lasta.toLocaleString('sv')} lästa…`);
  }
  db.exec(args.dry ? 'ROLLBACK' : 'COMMIT');
} catch (e) {
  db.exec('ROLLBACK');
  throw e;
}

const t = (v) => v.toLocaleString('sv');
console.log(`\n${args.dry ? 'Torrkörning (inget sparat)' : 'Klart'}: ${t(n.lasta)} juridiska enheter lästa, `
  + `${t(n.uppdaterade)} bolag uppdaterade, ${t(n.saknas)} finns inte i bolag, ${t(n.person)} enskilda firmor hoppades över.\n`
  + `  Ägarkontroll: ${Object.entries(n.perVarde).map(([k, v]) => `${k}: ${t(v)}`).join(', ')}`);
