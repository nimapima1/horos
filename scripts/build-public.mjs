// Bygger data/public.sqlite: den enda databas som får laddas upp till den publika servern.
//
// Den innehåller bara fastigheter som
//   - har minst en känd juridisk ägare (lagfart eller taxering),
//   - inte har någon fysisk person bland ägarna (har_privat_agare),
//   - inte är exempeldata,
// och bara de bolag som äger eller har förvärvat någon av dem (om inte --alla-bolag anges).
// Det motsvarar åtagandet i ansökan till Lantmäteriet.
//
//   node scripts/build-public.mjs [--lm-beslut <ärendenummer>] [--alla-bolag] [--export-geometri]
//                                 [--out data/public.sqlite]
//
// --export-geometri gör fastighetsgränserna nedladdningsbara som GeoJSON. Ange det bara om
// Lantmäteriets beslut tillåter vidarespridning av geometrierna.
//
// Data från Lantmäteriets fastighetsindelning tas bara med om --lm-beslut anges, dvs.
// när ansökan har beviljats. Läs beslutets villkor innan du publicerar.
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { openDb, DB_PATH, ROOT } from '../lib/db.mjs';
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
src.close();

for (const f of [OUT, `${OUT}-wal`, `${OUT}-shm`]) rmSync(f, { force: true });
const db = openDb({ path: OUT });
db.exec('DROP TABLE har_privat_agare');
db.exec(`ATTACH DATABASE '${DB_PATH.replace(/'/g, "''")}' AS src`);

db.exec('BEGIN');
db.exec(`
  CREATE TEMP TABLE tillaten AS
    SELECT f.beteckning FROM src.fastighet f
    WHERE f.demo = 0
      AND f.beteckning NOT IN (SELECT beteckning FROM src.har_privat_agare)
      AND (EXISTS (SELECT 1 FROM src.agande a WHERE a.beteckning = f.beteckning AND a.demo = 0)
        OR EXISTS (SELECT 1 FROM src.taxering t WHERE t.beteckning = f.beteckning AND t.demo = 0 AND t.agare_orgnr IS NOT NULL));
  CREATE UNIQUE INDEX temp.tillaten_bet ON tillaten(beteckning);

  INSERT INTO fastighet SELECT * FROM src.fastighet WHERE beteckning IN (SELECT beteckning FROM tillaten);
  INSERT INTO agande SELECT * FROM src.agande WHERE demo = 0 AND beteckning IN (SELECT beteckning FROM tillaten);
  INSERT INTO taxering SELECT * FROM src.taxering WHERE demo = 0 AND agare_orgnr IS NOT NULL
    AND beteckning IN (SELECT beteckning FROM tillaten);
  INSERT INTO transaktion SELECT * FROM src.transaktion WHERE demo = 0 AND beteckning IN (SELECT beteckning FROM tillaten);
`);
if (args['alla-bolag']) {
  db.exec('INSERT INTO bolag SELECT * FROM src.bolag WHERE demo = 0');
} else {
  db.exec(`INSERT INTO bolag SELECT * FROM src.bolag WHERE demo = 0 AND orgnr IN (
    SELECT orgnr FROM agande UNION SELECT agare_orgnr FROM taxering UNION SELECT forvarvare_orgnr FROM transaktion)`);
}
db.exec(`CREATE TABLE meta (nyckel TEXT PRIMARY KEY, varde TEXT);
  INSERT INTO meta VALUES ('byggd', datetime('now')), ('lm_beslut', ${args['lm-beslut'] ? `'${String(args['lm-beslut']).replace(/'/g, "''")}'` : 'NULL'}),
    ('export_geometri', '${args['export-geometri'] ? '1' : '0'}');`);
db.exec('COMMIT');
db.exec('DETACH DATABASE src');

db.exec(`CREATE VIRTUAL TABLE bolag_fts USING fts5(namn, content='bolag', content_rowid='rowid');
  INSERT INTO bolag_fts(bolag_fts) VALUES('rebuild');`);
// Servern öppnar filen skrivskyddat: ingen WAL, kompakt fil.
db.exec('PRAGMA journal_mode = DELETE; VACUUM;');

const c = db.prepare(`SELECT (SELECT count(*) FROM fastighet) f, (SELECT count(*) FROM bolag) b,
  (SELECT count(*) FROM taxering) t, (SELECT count(*) FROM agande) a, (SELECT count(*) FROM transaktion) x`).get();
db.close();
console.log(`Klart: ${OUT}\n  ${c.f} fastigheter, ${c.b} bolag, ${c.t} taxeringar, ${c.a} ägarposter, ${c.x} överlåtelser`);
if (!c.f) console.log('  (Inga fastigheter ännu: väntar på Lantmäteriet/Skatteverket. Sidan blir en tom karta'
  + (args['alla-bolag'] ? ' med bolagssök.)' : '; kör med --alla-bolag för att kunna söka bland alla bolag.)'));
