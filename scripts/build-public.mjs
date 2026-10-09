// Bygger data/public.sqlite: den enda databas som får laddas upp till den publika servern.
//
// Den innehåller bara fastigheter som
//   - har minst en känd juridisk ägare (lagfart eller taxering),
//   - inte har någon fysisk person bland ägarna (har_privat_agare),
//   - inte är exempeldata,
// och bara de bolag som äger eller har förvärvat någon av dem eller har ett arbetsställe på dem
// (om inte --alla-bolag anges).
// Det motsvarar åtagandet i ansökan till Lantmäteriet.
//
//   node scripts/build-public.mjs [--lm-beslut <ärendenummer>] [--lm-planer <ärendenummer>]
//                                 [--scb-villkor] [--alla-bolag] [--export-geometri] [--out data/public.sqlite]
//
// --export-geometri gör fastighetsgränserna nedladdningsbara som GeoJSON. Ange det bara om
// Lantmäteriets beslut tillåter vidarespridning av geometrierna.
//
// Data från Lantmäteriets fastighetsindelning tas bara med om --lm-beslut anges, dvs.
// när ansökan har beviljats. Läs beslutets villkor innan du publicerar. Planerna (Markreglerande
// bestämmelse) är en egen licens och tas bara med om --lm-planer anges. Arbetsställena (SCB:s
// företagsregister) tas bara med om --scb-villkor anges, dvs. när SCB:s användarvillkor är lästa
// och tillåter publicering per adress.
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { openDb, DB_PATH, ROOT, harJuridiskAgare, rebuildAdressFts, rebuildBolagFts, rebuildRtree, withTransaction } from '../lib/db.mjs';
import { parseArgs } from '../lib/csv.mjs';

const args = parseArgs(process.argv.slice(2));
const OUT = args.out ?? join(ROOT, 'data', 'public.sqlite');
if (!existsSync(DB_PATH)) { console.error(`Hittar inte ${DB_PATH}. Kör importerna först.`); process.exit(1); }

const src = openDb();
const lmRader = src.prepare("SELECT count(*) AS n FROM fastighet WHERE kalla = 'lantmateriet' AND demo = 0").get().n;
if (lmRader && !args['lm-beslut']) {
  console.error(`Databasen innehåller ${lmRader} fastigheter från Lantmäteriet. Ange ärendenumret för beslutet\n`
    + 'med --lm-beslut <nr> när ansökan har beviljats (och läs villkoren i beslutet).');
  process.exit(1);
}
const planRader = src.prepare('SELECT count(*) AS n FROM plan WHERE demo = 0').get().n;
const aeRader = src.prepare('SELECT count(*) AS n FROM arbetsstalle WHERE demo = 0').get().n;
if (aeRader && !args['scb-villkor']) console.log(`Hoppar över ${aeRader} arbetsställen: ange --scb-villkor när SCB:s villkor är lästa.`);
if (planRader && !args['lm-planer']) console.log(`Hoppar över ${planRader} planer: ange --lm-planer <ärendenr> när licensen finns.`);
src.close();

for (const f of [OUT, `${OUT}-wal`, `${OUT}-shm`]) rmSync(f, { force: true });
const db = openDb({ path: OUT });
db.exec('DROP TABLE har_privat_agare');
db.exec(`ATTACH DATABASE '${DB_PATH.replace(/'/g, "''")}' AS src`);

withTransaction(db, () => {
  db.exec(`
    CREATE TEMP TABLE tillaten AS
      SELECT f.beteckning FROM src.fastighet f
      WHERE f.demo = 0
        AND f.beteckning NOT IN (SELECT beteckning FROM src.har_privat_agare)
        AND ${harJuridiskAgare({ schema: 'src.', extra: 'AND k.demo = 0' })};
    CREATE UNIQUE INDEX temp.tillaten_bet ON tillaten(beteckning);

    INSERT INTO fastighet SELECT * FROM src.fastighet WHERE beteckning IN (SELECT beteckning FROM tillaten);
    INSERT INTO agande SELECT * FROM src.agande WHERE demo = 0 AND beteckning IN (SELECT beteckning FROM tillaten);
    INSERT INTO taxering SELECT * FROM src.taxering WHERE demo = 0 AND agare_orgnr IS NOT NULL
      AND beteckning IN (SELECT beteckning FROM tillaten);
    INSERT INTO transaktion SELECT * FROM src.transaktion WHERE demo = 0 AND beteckning IN (SELECT beteckning FROM tillaten);
    -- Arbetsställen (SCB) bara på tillåtna fastigheter; importen har redan tagit bort enskilda
    -- firmor och reklamspärrade, och villkoret på orgnr är en extra spärr mot personnummer.
    ${args['scb-villkor'] ? `INSERT INTO arbetsstalle SELECT * FROM src.arbetsstalle WHERE demo = 0
      AND substr(orgnr, 3, 1) >= '2' AND beteckning IN (SELECT beteckning FROM tillaten);` : ''}
    INSERT INTO bolag SELECT * FROM src.bolag WHERE demo = 0 ${args['alla-bolag'] ? '' : `AND orgnr IN (
      SELECT orgnr FROM agande UNION SELECT agare_orgnr FROM taxering UNION SELECT forvarvare_orgnr FROM transaktion
      UNION SELECT orgnr FROM arbetsstalle)`};
    -- Alla adresser (öppna OSM-data, inga personuppgifter), så att sökningen även kan svara
    -- att en adress inte har någon fastighet i Horos.
    INSERT INTO adress SELECT * FROM src.adress;
    ${args['lm-planer'] ? 'INSERT INTO plan SELECT * FROM src.plan WHERE demo = 0;' : ''}
    CREATE TABLE meta (nyckel TEXT PRIMARY KEY, varde TEXT);
  `);
  const meta = db.prepare('INSERT INTO meta VALUES (?, ?)');
  meta.run('byggd', new Date().toISOString().slice(0, 19).replace('T', ' '));
  meta.run('lm_beslut', args['lm-beslut'] ? String(args['lm-beslut']) : null);
  meta.run('lm_planer', args['lm-planer'] ? String(args['lm-planer']) : null);
  meta.run('export_geometri', args['export-geometri'] ? '1' : '0');
});
db.exec('DETACH DATABASE src');

rebuildBolagFts(db);
rebuildAdressFts(db);
rebuildRtree(db, 'fastighet');
rebuildRtree(db, 'plan');
// Servern öppnar filen skrivskyddat: ingen WAL, kompakt fil.
db.exec('PRAGMA journal_mode = DELETE; VACUUM;');

const c = db.prepare(`SELECT (SELECT count(*) FROM fastighet) f, (SELECT count(*) FROM bolag) b,
  (SELECT count(*) FROM taxering) t, (SELECT count(*) FROM agande) a, (SELECT count(*) FROM transaktion) x,
  (SELECT count(*) FROM adress) ad, (SELECT count(*) FROM plan) p, (SELECT count(*) FROM arbetsstalle) ae`).get();
db.close();
console.log(`Klart: ${OUT}\n  ${c.f} fastigheter, ${c.b} bolag, ${c.t} taxeringar, ${c.a} ägarposter, ${c.x} överlåtelser, ${c.ad} adresser, ${c.p} planer, ${c.ae} arbetsställen`);
if (!c.f) console.log('  (Inga fastigheter ännu: väntar på Lantmäteriet/Skatteverket. Sidan blir en tom karta'
  + (args['alla-bolag'] ? ' med bolagssök.)' : '; kör med --alla-bolag för att kunna söka bland alla bolag.)'));
