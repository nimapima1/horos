// import-arbetsstallen: vad som utesluts och kopplingen till fastighet; publikt läge vägrar
// starta med ett arbetsställe som tillhör en fysisk person.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, openDb } from '../lib/db.mjs';
import { sweref99tmToWgs84 } from '../lib/geo.mjs';

const DIR = join(ROOT, 'data', '_test');
const DB = join(DIR, 'arbetsstallen-test.sqlite');
const FIL = join(DIR, 'arbetsstallen-test.json');
const node = (args, env) => spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', ...args],
  { env: { ...process.env, FASTIGHETSKARTA_DB: DB, ...env }, encoding: 'utf8', timeout: 20_000 });

// Ett arbetsställe i SCB:s format (/v1/arbetsstallen/full) med adresskoordinat (ost, nord).
const ae = (cfarNr, peOrgNr, [ost, nord], extra = {}) => ({
  cfarNr, peOrgNr, ben: '', aeStat: 1, aeTyp: 1, anstKl: 3, reklamSparrTyp: 1, tel: '08-123', epost: 'x@example.se',
  belagenhetsadress: { lan: '01', kommun: '0180', bGatuAdress: 'Testgatan 1', bPostNr: '11122', bPostOrt: 'STOCKHOLM' },
  geografiskInformation: { ostKoordinatSW: ost, nordKoordinatSW: nord, ostKoordinatAdressSW: ost, nordKoordinatAdressSW: nord },
  naringsgrenar: [{ rangordning: 2, naringsgren: '47710', avdelningsKod: 'G' }, { rangordning: 1, naringsgren: '62100', avdelningsKod: 'K' }],
  ...extra,
});

test('import-arbetsstallen utesluter fysiska personer och ej verksamma, märker reklamspärr och kopplar till fastighet', () => {
  mkdirSync(DIR, { recursive: true });
  for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) rmSync(f, { force: true });
  const [lon, lat] = sweref99tmToWgs84(674000, 6580000);
  const d = 0.0005;
  const db = openDb({ path: DB });
  db.prepare(`INSERT INTO fastighet (beteckning, geojson, minx, miny, maxx, maxy, kalla) VALUES ('T 1:1', ?, ?, ?, ?, ?, 'lantmateriet')`)
    .run(JSON.stringify({ type: 'Polygon', coordinates: [[[lon - d, lat - d], [lon + d, lat - d], [lon + d, lat + d], [lon - d, lat + d], [lon - d, lat - d]]] }),
      lon - d, lat - d, lon + d, lat + d);
  db.close();

  const P = [674000, 6580000], LANGT_BORT = [680000, 6590000];
  writeFileSync(FIL, JSON.stringify([
    { pagination: { hasMore: true }, arbetsstallen: [
      ae(10000001, '165560000001', P, { ben: 'Butiken' }),
      ae(10000002, '198001011234', P),                        // enskild firma (personnummer)
      ae(10000003, '165560000003', P, { reklamSparrTyp: 2 }),
    ] },
    { pagination: { hasMore: false }, arbetsstallen: [
      ae(10000004, '165560000004', P, { aeStat: 9 }),
      ae(10000005, '162120000005', P, { aeTyp: 3 }),           // fiktivt (kommunens rörliga personal)
      ae(10000006, '165560000006', [0, 0]),                    // utan koordinater
      ae(10000007, '165560000007', LANGT_BORT),                // ingen fastighet i Horos
    ] },
  ]));
  writeFileSync(`${FIL}.sni`, JSON.stringify([{ kod: '62100', klartext: 'Dataprogrammering', avdelningKod: 'K' }]));

  const dry = node([join(ROOT, 'scripts', 'import-arbetsstallen.mjs'), '--fil', FIL, '--sni', `${FIL}.sni`, '--dry']);
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /1 med reklamspärr\.\n.*1 enskilda firmor, 1 ej verksamma, 1 fiktiva, 1 utan koordinater/);
  const r = node([join(ROOT, 'scripts', 'import-arbetsstallen.mjs'), '--fil', FIL, '--sni', `${FIL}.sni`]);
  assert.equal(r.status, 0, r.stderr);

  const ro = openDb({ path: DB, readOnly: true });
  const rows = ro.prepare('SELECT cfar, orgnr, benamning, sni, avdelning, bransch, anstkl, adress, beteckning, lokaltyp, loa_m2, reklamsparr FROM arbetsstalle ORDER BY cfar').all();
  ro.close();
  const K = { sni: '62100', avdelning: 'K', bransch: 'Dataprogrammering', anstkl: 3, adress: 'Testgatan 1', lokaltyp: 'Kontor', loa_m2: 140 };
  assert.deepEqual(rows.map((x) => ({ ...x })), [
    { cfar: 10000001, orgnr: '5560000001', benamning: 'Butiken', ...K, beteckning: 'T 1:1', reklamsparr: 0 },
    { cfar: 10000003, orgnr: '5560000003', benamning: null, ...K, beteckning: 'T 1:1', reklamsparr: 1 },   // sparas, märks
    { cfar: 10000007, orgnr: '5560000007', benamning: null, ...K, beteckning: null, reklamsparr: 0 },
  ]);
});

test('publikt läge vägrar starta med ett arbetsställe som tillhör en fysisk person', () => {
  const db = openDb({ path: DB });
  db.exec(`DROP TABLE har_privat_agare; DELETE FROM arbetsstalle WHERE beteckning IS NULL;
    INSERT INTO agande (beteckning, orgnr) VALUES ('T 1:1', '5560000001');
    INSERT INTO arbetsstalle (cfar, orgnr, beteckning) VALUES (10000008, '8001011234', 'T 1:1');`);
  db.close();
  const r = node([join(ROOT, 'server.mjs')], { PUBLIC_MODE: '1', PORT: '3018' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /1 arbetsställen med personnummer/);
});
