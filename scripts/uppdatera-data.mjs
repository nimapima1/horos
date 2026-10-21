// Körs bara på en arbetskopia av den publika databasen, av deploy/uppdatera.sh.
import { DatabaseSync } from 'node:sqlite';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { openDb, ROOT, rebuildRtree, harJuridiskAgare, normOrgnr } from '../lib/db.mjs';
import { hamtaNgp, ngpPlaner, sparaNgp } from '../lib/ngp.mjs';
import { markeraPlanHamtning } from '../lib/uppdateringsmeta.mjs';

const STATUSAR = "'påbörjad','samråd','granskning','antagen','överklagad','tillsyn','laga kraft'";

export async function uppdateraData(path, { env = process.env, hamta = hamtaNgp,
  run = (script, args = [], accepted = [0]) => {
    try {
      execFileSync(process.execPath, [join(ROOT, 'scripts', script), ...args], {
        env: { ...env, FASTIGHETSKARTA_DB: path, HOROS_STRIKT: '1' }, stdio: ['ignore', 'inherit', 'inherit'], timeout: 60 * 60 * 1000,
      });
    } catch (error) { if (!accepted.includes(error.status)) throw error; }
  } } = {}) {
  const src = new DatabaseSync(path, { readOnly: true });
  try {
    if (src.prepare("SELECT 1 FROM sqlite_master WHERE name='har_privat_agare'").get()) throw new Error('Uppdateringen kräver en publik databas, inte arbetsdatabasen.');
  } finally { src.close(); }
  let db = openDb({ path });
  db.exec('CREATE TABLE IF NOT EXISTS meta (nyckel TEXT PRIMARY KEY, varde TEXT)');
  const tillstand = {};
  const stamp = (key, status, reason = '') => { tillstand[key] = { status, tid: new Date().toISOString(), orsak: reason }; };
  try {
    const tidigare = db.prepare("SELECT varde FROM meta WHERE nyckel='ngp_kommuner'").get()?.varde;
    const kommuner = [...new Set((env.NGP_KOMMUNER ? env.NGP_KOMMUNER.split(',').map((k) => k.trim())
      : tidigare ? JSON.parse(tidigare) : db.prepare("SELECT DISTINCT kommun FROM plan WHERE kalla='ngp'").all().map((r) => r.kommun)))];
    if (kommuner.some((k) => !/^\d{4}$/.test(k))) throw new Error('Ogiltig kommunkod i uppdateringsinställningen.');
    if (kommuner.length) {
      if (!env.GEOTORGET_USER || !env.GEOTORGET_PASS) throw new Error('NGP kräver Geotorget-inloggning i serverns secrets.env.');
      for (const kommun of kommuner) {
        const features = await hamta(kommun, env.GEOTORGET_USER, env.GEOTORGET_PASS);
        if (!features.some((f) => f.properties?.feature?.typ === 'detaljplan')) throw new Error(`NGP gav inga planer för ${kommun}. Behåller den tidigare databasen.`);
        // Plandokumenten hämtas inte här: servern hämtar dem vid första klicket (/plandokument/ngp/).
        sparaNgp(db, ngpPlaner(features, kommun), kommun);
      }
      markeraPlanHamtning(db, kommuner);
      // Historiken finns i den arkiverade databasversionen; publicera bara aktuella planer.
      db.exec(`DELETE FROM plan WHERE kalla='ngp' AND status NOT IN (${STATUSAR})`);
      rebuildRtree(db, 'plan');
      stamp('planer', 'uppdaterad');
    } else stamp('planer', 'vantar', 'Inga kommuner har importerats eller konfigurerats.');
    db.close(); db = null;

    run('import-nyheter.mjs', ['--publik', path], [0, 3]);
    const mfn = env.MFN_DB || '/var/lib/horos-scenarion/mfn.sqlite';
    if (existsSync(mfn)) run('import-nyheter.mjs', ['--publik', path, '--mfn', mfn,
      '--undanta', env.MFN_UNDANTAG || '/var/lib/fastighetskarta/mfn-undantag.txt'], [0, 3]);
    stamp('nyheter', 'uppdaterad');

    if (env.SCB_API_KEY) {
      run('import-agarkontroll.mjs');
      stamp('agarkontroll', 'uppdaterad');
      const check = new DatabaseSync(path, { readOnly: true });
      const antal = check.prepare('SELECT count(*) AS n FROM fastighet').get().n;
      check.close();
      if (env.HOROS_SCB_VILLKOR === '1' && antal) {
        run('import-arbetsstallen.mjs');
        stamp('arbetsstallen', 'uppdaterad');
      } else stamp('arbetsstallen', 'vantar', 'Kräver fastighetsdata och HOROS_SCB_VILLKOR=1.');
    } else {
      stamp('agarkontroll', 'vantar', 'SCB_API_KEY saknas på servern.');
      stamp('arbetsstallen', 'vantar', 'SCB_API_KEY saknas på servern.');
    }
    for (const key of ['fastigheter', 'agare', 'kopeskillingar', 'taxering', 'bolagsregister', 'adresser', 'fororenade', 'utsatta', 'flygfoton']) {
      stamp(key, 'manuell', 'Ingen automatisk uppdatering inkopplad för denna källa.');
    }

    db = openDb({ path });
    // SCB-importen läser hela landet. Bara juridiska arbetsställen på tillåtna fastigheter får publiceras.
    db.exec(`DELETE FROM arbetsstalle WHERE demo != 0 OR beteckning IS NULL OR beteckning NOT IN (SELECT beteckning FROM fastighet)`);
    for (const row of db.prepare('SELECT cfar, orgnr FROM arbetsstalle').all()) {
      if (!normOrgnr(row.orgnr)) throw new Error('Arbetsställe med fysisk ägare. Uppdateringen avbryts.');
    }
    for (const t of ['fastighet', 'bolag', 'agande', 'taxering', 'transaktion', 'plan', 'arbetsstalle']) {
      if (db.prepare(`SELECT 1 FROM ${t} WHERE demo != 0 LIMIT 1`).get()) throw new Error('Exempeldata får inte publiceras.');
    }
    if (db.prepare(`SELECT 1 FROM fastighet f WHERE NOT ${harJuridiskAgare()} LIMIT 1`).get()) throw new Error('Fastighet utan juridisk ägare. Uppdateringen avbryts.');
    db.exec('DROP TABLE har_privat_agare'); // openDb skapade en tom tabell på den publika arbetskopian.
    const meta = db.prepare('INSERT OR REPLACE INTO meta VALUES (?, ?)');
    meta.run('uppdatering', JSON.stringify(tillstand));
    meta.run('uppdaterad', new Date().toISOString());
    rebuildRtree(db, 'fastighet'); rebuildRtree(db, 'plan');
    if (db.prepare('PRAGMA quick_check').get().quick_check !== 'ok') throw new Error('Databaskontrollen misslyckades.');
    db.exec('PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=DELETE;');
    return tillstand;
  } finally { db?.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const path = process.argv[2];
    if (!path || !process.env.HOROS_UPPDATERING_ARBETE || resolve(path) !== resolve(process.env.HOROS_UPPDATERING_ARBETE)) {
      throw new Error('Kör via deploy/uppdatera.sh, som skapar och låser arbetskopian.');
    }
    console.log(JSON.stringify(await uppdateraData(path)));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
