// Behåll nyare serverhämtningar när en lokalt byggd publik databas laddas upp.
import { DatabaseSync } from 'node:sqlite';
import { hasColumn, rebuildRtree, withTransaction } from '../lib/db.mjs';
import { metaVarde, planTider, markeraPlanHamtning } from '../lib/uppdateringsmeta.mjs';

export function behallPlaner(ny, gammal) {
  for (const key of ['scb_agarkontroll_hamtad', 'scb_arbetsstallen_hamtad']) {
    const oldDate = metaVarde(gammal, key), newDate = metaVarde(ny, key);
    if (oldDate && (!newDate || newDate < oldDate)) throw new Error(`SCB-data på servern är nyare (${key}). Uppdatera det lokala underlaget och bygg om databasen före deploy --data.`);
  }
  const oldTimes = planTider(gammal), newTimes = planTider(ny);
  const kommuner = [...oldTimes.keys()].filter((k) => !newTimes.has(k) || (oldTimes.get(k) && (!newTimes.get(k) || oldTimes.get(k) > newTimes.get(k))));
  if (!kommuner.length) return false;
  const columns = ny.prepare("SELECT name FROM pragma_table_info('plan')").all().map((r) => r.name);
  const select = columns.map((c) => hasColumn(gammal, 'plan', c) ? c : `NULL AS ${c}`).join(',');
  const rows = gammal.prepare(`SELECT ${select} FROM plan WHERE kalla='ngp' AND kommun=?`);
  withTransaction(ny, () => {
    // Den uppladdade arbetskopian ersätts; båda originalversionerna behålls av deploy/arkiv.
    const del = ny.prepare("DELETE FROM plan WHERE kalla='ngp' AND kommun=?");
    const ins = ny.prepare(`INSERT INTO plan (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`);
    // Spara även tiderna för kommuner som behålls från den lokala databasen.
    markeraPlanHamtning(ny, []);
    for (const kommun of kommuner) {
      del.run(kommun);
      for (const r of rows.all(kommun)) ins.run(...columns.map((c) => r[c]));
      markeraPlanHamtning(ny, [kommun], oldTimes.get(kommun) ?? null);
    }
  });
  rebuildRtree(ny, 'plan');
  return true;
}

if (process.argv[1]?.endsWith('behall-planer.mjs')) {
  const ny = new DatabaseSync(process.argv[2]), gammal = new DatabaseSync(process.argv[3], { readOnly: true });
  try { console.log(behallPlaner(ny, gammal) ? 'Behåller serverns nyare NGP-planer.' : 'Den uppladdade planversionen används.'); }
  finally { ny.close(); gammal.close(); }
}
