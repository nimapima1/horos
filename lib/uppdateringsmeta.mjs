export function metaVarde(db, key) {
  return db.prepare("SELECT 1 FROM sqlite_master WHERE name='meta'").get()
    ? db.prepare('SELECT varde FROM meta WHERE nyckel=?').get(key)?.varde : null;
}

export function planTider(db) {
  const tidsrader = db.prepare("SELECT 1 FROM sqlite_master WHERE name='meta'").get()
    ? db.prepare("SELECT nyckel,varde FROM meta WHERE nyckel LIKE 'planer_hamtade:%'").all() : [];
  const tider = new Map(tidsrader.map((r) => [r.nyckel.slice('planer_hamtade:'.length), r.varde]));
  // Äldre versioner hade bara en tid för hela uttaget. Använd den bara för kommuner som faktiskt finns.
  if (!tidsrader.length) {
    const tid = metaVarde(db, 'planer_hamtade');
    for (const { kommun } of db.prepare("SELECT DISTINCT kommun FROM plan WHERE kalla='ngp'").all()) tider.set(kommun, tid);
  }
  return tider;
}

export function markeraPlanHamtning(db, kommuner, tid = new Date().toISOString()) {
  const tider = planTider(db);
  for (const kommun of kommuner) tider.set(kommun, tid);
  db.exec('CREATE TABLE IF NOT EXISTS meta(nyckel TEXT PRIMARY KEY,varde TEXT)');
  const ins = db.prepare('INSERT OR REPLACE INTO meta VALUES (?,?)');
  for (const [kommun, stamp] of tider) ins.run(`planer_hamtade:${kommun}`, stamp ?? null);
  ins.run('planer_hamtade', [...tider.values()].filter(Boolean).sort().at(-1) ?? tid);
  ins.run('ngp_kommuner', JSON.stringify([...tider.keys()].sort()));
}
