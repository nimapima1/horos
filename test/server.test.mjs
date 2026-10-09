// Startar servern mot en liten testdatabas och kontrollerar kartfiltren, affärerna,
// största ägare, grannar och träff-exporten.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, openDb } from '../lib/db.mjs';

const DB = join(ROOT, 'data', '_test', 'server-test.sqlite');
const PORT = 3017;
let server;

const rect = (x0, y0, x1, y1) => JSON.stringify({ type: 'Polygon', coordinates: [[[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]] });

before(async () => {
  for (const ext of ['', '-wal', '-shm']) rmSync(DB + ext, { force: true });
  const db = openDb({ path: DB });
  db.exec(`INSERT INTO bolag (orgnr, namn, jurform, sni) VALUES
    ('5560000001', 'Alfa AB', 'Aktiebolag', '68201'), ('7690000002', 'Brf Beta', 'Bostadsrättsförening', NULL)`);
  const insF = db.prepare(`INSERT INTO fastighet (beteckning, kommun, areal_m2, geojson, minx, miny, maxx, maxy, kalla)
    VALUES (?, 'Testkommun', ?, ?, ?, ?, ?, ?, 'lantmateriet')`);
  // 1:1 och 1:2 gränsar till varandra, 1:3 ligger en bit bort.
  for (const [bet, m2, b] of [['T 1:1', 1000, [18.000, 59.000, 18.001, 59.0005]], ['T 1:2', 500, [18.001, 59.000, 18.002, 59.0005]],
    ['T 1:3', 4000, [18.010, 59.000, 18.011, 59.0005]]]) insF.run(bet, m2, rect(...b), ...b);
  db.exec(`INSERT INTO taxering (beteckning, typ, ar, varde_tkr) VALUES
    ('T 1:1', 'Hyreshusenhet, lokaler', 2025, 50000), ('T 1:1', 'Hyreshusenhet, lokaler', 2022, 40000),
    ('T 1:2', 'Hyreshusenhet, bostäder', 2025, 10000), ('T 1:3', 'Hyreshusenhet, lokaler', 2025, 200000)`);
  // Upplåtelseform: 1:1 tomträtt, 1:2 äganderätt, 1:3 okänd (källan säger inget).
  db.exec(`INSERT INTO agande (beteckning, orgnr, inskrivningsdag, tomtratt) VALUES
    ('T 1:1', '5560000001', '2024-05-01', 1), ('T 1:2', '7690000002', '2020-01-01', 0), ('T 1:3', '5560000001', '2024-05-01', NULL)`);
  // Paketaffär: Alfa köper 1:1 och 1:3 för 300 Mkr; köpeskillingen står på båda.
  db.exec(`INSERT INTO transaktion (beteckning, inskrivningsdag, kopeskilling_kr, forvarvare_orgnr) VALUES
    ('T 1:1', '2024-05-01', 300000000, '5560000001'), ('T 1:3', '2024-05-01', 300000000, '5560000001'),
    ('T 1:2', '2020-01-01', 20000000, '7690000002')`);
  // Arbetsställen: två på 1:1 (Alfa är störst), ett utan fastighet. Uppskattad LOA på 1:1:
  // kontor 34,5 anställda × 20 m² = 690, butik 2,5 × 40 = 100.
  db.exec(`INSERT INTO arbetsstalle (cfar, orgnr, benamning, sni, avdelning, bransch, anstkl, adress, beteckning) VALUES
    (1, '7690000002', NULL, '47110', 'G', 'Livsmedelsbutik', 2, 'Testgatan 2', 'T 1:1'),
    (2, '5560000001', 'Alfa City', '62100', 'K', 'Dataprogrammering', 5, 'Testgatan 1', 'T 1:1'),
    (3, '5560000001', NULL, NULL, NULL, NULL, 3, 'Annangatan 9', NULL)`);
  db.close();

  server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', join(ROOT, 'server.mjs')], {
    env: { ...process.env, PORT: String(PORT), FASTIGHETSKARTA_DB: DB, PUBLIC_MODE: '' },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  await new Promise((resolve, reject) => {
    server.stdout.on('data', (d) => { if (String(d).includes(`:${PORT}`)) resolve(); });
    server.on('exit', (code) => reject(new Error(`servern avslutades (${code})`)));
  });
});
after(() => server?.kill());

const get = (path) => fetch(`http://127.0.0.1:${PORT}${path}`);
const json = (path) => get(path).then((r) => r.json());
const BBOX = 'bbox=17.99,58.99,18.02,59.01';
const antal = async (filter) => (await json(`/api/fastigheter?${BBOX}${filter}`)).features.length;

test('kartfiltren', async () => {
  assert.equal(await antal(''), 3);
  assert.equal(await antal('&jur=Bostadsrättsförening'), 1);
  assert.equal(await antal('&vmin=100'), 1);            // Mkr
  assert.equal(await antal('&vmax=20'), 1);
  assert.equal(await antal('&kar=2021'), 2);
  assert.equal(await antal('&ktill=2020'), 1);
  assert.equal(await antal('&anv=Hyreshusenhet%2C%20lokaler'), 2);
  assert.equal(await antal('&amin=2000'), 1);
  assert.equal(await antal('&amax=600'), 1);
  assert.equal(await antal('&lok=Kontor'), 1);
  assert.equal(await antal('&rf=tomtratt'), 1);
  assert.equal(await antal('&rf=aganderatt'), 1);   // 1:3 är okänd och räknas inte som äganderätt
  assert.equal(await antal('&rf=nagot'), 3);
  assert.equal(await antal('&kommun=Testkommun'), 3);
  assert.equal(await antal('&kommun=Solna'), 0);
  assert.equal(await antal('&lan=01'), 0);           // Testkommun ligger inte i Stockholms län
  assert.equal(await antal('&lan=99'), 3);           // okänd länskod ignoreras
  assert.equal(await antal('&agare=ALFA'), 2);
  assert.equal(await antal('&agare=556000-0001'), 2);
  assert.equal(await antal('&agare=gamma%20beta'), 0);
  assert.equal(await antal('&agkat=brf'), 1);
  assert.equal(await antal('&agkat=fastighetsbolag'), 2);   // Alfa AB har SNI 68201
  assert.equal(await antal('&agkat=ovriga'), 0);
  assert.equal(await antal('&agkat=kommun'), 0);
  assert.equal(await antal('&lok=Industri'), 0);
  assert.equal(await antal('&loamin=700'), 1);
  assert.equal(await antal('&loamin=800'), 0);
  assert.equal(await antal('&loamax=800'), 1);       // fastigheter utan uppskattad LOA räknas inte
  assert.equal(await antal('&vmin=abc&kar=20x'), 3);    // ogiltiga värden ignoreras
  assert.equal(await antal('&kar=2021&vmin=100'), 1);
  assert.equal((await get('/api/fastigheter')).status, 400);
});

test('senaste köp räknar bara överlåtelser med pris', async () => {
  const db = openDb({ path: DB });
  // En gåva utan pris efter paketköpet 2024: senaste köp är fortfarande 2024 för 300 Mkr.
  db.exec("INSERT INTO transaktion (beteckning, inskrivningsdag, kopeskilling_kr, forvarvare_orgnr) VALUES ('T 1:3', '2025-01-01', NULL, '5560000001')");
  try {
    assert.equal(await antal('&kmin=250'), 2);
    assert.equal(await antal('&ktill=2024'), 3);
  } finally {
    db.exec("DELETE FROM transaktion WHERE beteckning = 'T 1:3' AND inskrivningsdag = '2025-01-01'");
    db.close();
  }
});

test('prickar och bolagsurval', async () => {
  assert.equal((await json(`/api/punkter?${BBOX}`)).p.length, 3);
  assert.equal((await json(`/api/punkter?${BBOX}&org=556000-0001`)).p.length, 2);
});

test('affärer räknar en paketaffär en gång', async () => {
  const a = await json('/api/affarer');
  assert.deepEqual(a.arLista, ['2024', '2020']);
  assert.equal(a.ar, '2024');
  assert.deepEqual(a.summa, { antal: 1, kr: 300000000 });
  assert.equal(a.senaste[0].antal, 2);
  assert.equal(a.kopare[0].namn, 'Alfa AB');
  assert.deepEqual(a.perKommun, [{ kommun: 'Testkommun', antal: 1, kr: 300000000 }]);
  assert.deepEqual((await json('/api/affarer?kommun=Testkommun')).perKommun, []);   // bara utan vald kommun
  assert.deepEqual((await json('/api/affarer?ar=2020')).summa, { antal: 1, kr: 20000000 });
  assert.deepEqual((await json('/api/affarer?min=100')).arLista, ['2024']);   // köpet 2020 är under 100 Mkr
});

test('största ägare', async () => {
  const r = await json('/api/storsta-agare?efter=varde');
  assert.equal(r.agare[0].namn, 'Alfa AB');
  assert.equal(r.agare[0].antal, 2);
  assert.equal(r.agare[0].varde_tkr, 250000);
  const utsnitt = await json('/api/storsta-agare?bbox=17.999,58.999,18.0005,59.001');
  assert.deepEqual(utsnitt.agare.map((a) => a.namn), ['Alfa AB']);
});

test('fastighet: grannar, paketaffär och köp i närheten', async () => {
  const f = await json(`/api/fastighet/${encodeURIComponent('T 1:1')}`);
  assert.deepEqual(f.grannar.map((g) => g.beteckning), ['T 1:2']);
  assert.equal(f.transaktioner[0].i_affar, 2);
  assert.deepEqual(f.narKop.map((x) => [x.beteckning, x.paket]), [['T 1:2', false]]);   // 1:3 ligger ca 560 m bort
});

test('företag på adressen och bolagets arbetsställen', async () => {
  const f = await json(`/api/fastighet/${encodeURIComponent('T 1:1')}`);
  assert.deepEqual(f.hyresgaster.map((h) => [h.namn, h.benamning, h.anstkl, h.adress]),
    [['Alfa AB', 'Alfa City', 5, 'Testgatan 1'], ['Brf Beta', null, 2, 'Testgatan 2']]);
  assert.equal(f.upplatelse, 'tomtratt');
  assert.equal(f.agare[0].tomtratt, 1);
  assert.deepEqual(f.anvandning, [{ typ: 'Kontor', loa_m2: 690 }, { typ: 'Butik', loa_m2: 100 }]);
  assert.deepEqual((await json(`/api/fastighet/${encodeURIComponent('T 1:2')}`)).hyresgaster, []);
  const alfa = await json('/api/bolag/5560000001');
  assert.deepEqual(alfa.arbetsstallen.map((a) => [a.adress, a.beteckning]), [['Testgatan 1', 'T 1:1']]);   // bara på fastigheter i Horos
});

test('träff-export som CSV', async () => {
  const buf = Buffer.from(await get(`/data/horos-traffar.csv?${BBOX}&jur=Aktiebolag`).then((r) => r.arrayBuffer()));
  assert.equal(buf.subarray(0, 3).toString('hex'), 'efbbbf');   // BOM för Excel
  const rader = buf.toString('utf8').split('\r\n');
  assert.match(rader[0], /beteckning;agare;/);
  assert.equal(rader.length, 3);
});

test('bolag: köp och sålt (körs sist, lägger till en försäljning)', async () => {
  const db = openDb({ path: DB });
  db.exec(`INSERT INTO transaktion (beteckning, inskrivningsdag, kopeskilling_kr, forvarvare_orgnr)
    VALUES ('T 1:2', '2023-03-01', 35000000, '5560000001'),
      ('T 1:2', '2020-01-01', NULL, '7690000002')`);   // Beta köpte 2020 i två andelar samma dag
  db.close();
  const beta = await json('/api/bolag/7690000002');
  assert.deepEqual(beta.salt.map((x) => [x.beteckning, x.kopt, x.salt, x.kopare, x.salt_kr]),
    [['T 1:2', '2020-01-01', '2023-03-01', 'Alfa AB', 35000000]]);
  const alfa = await json('/api/bolag/5560000001');
  assert.deepEqual(alfa.kop.map((x) => [x.dag, x.antal]), [['2024-05-01', 2], ['2023-03-01', 1]]);
  assert.deepEqual(alfa.salt, []);
  const affar = (await json('/api/affarer?ar=2023')).senaste[0];
  assert.deepEqual([affar.namn, affar.saljare], ['Alfa AB', 'Brf Beta']);
  assert.equal((await json('/api/affarer?ar=2023')).senaste.length, 1);   // två andelar före ger ingen dubblett
});

test('sök: bolag med fastigheter först och med antal', async () => {
  const r = await json(`/api/sok?q=${encodeURIComponent('Alfa')}`);
  assert.deepEqual(r.bolag.map((b) => [b.namn, b.fastigheter]), [['Alfa AB', 2]]);
});

test('bolag: summor och inramning över alla fastigheter, även när listan är kapad', async () => {
  const db = openDb({ path: DB });
  // 501 fastigheter långt från de andra (påverkar inga bbox-tester), alla ägda av Gamma AB.
  db.exec(`INSERT INTO bolag (orgnr, namn, jurform) VALUES ('5560000003', 'Gamma AB', 'Aktiebolag');
    WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 501)
    INSERT INTO fastighet (beteckning, kommun, areal_m2, geojson, minx, miny, maxx, maxy, kalla)
      SELECT 'G ' || i, 'Testkommun', 10, '{"type":"Polygon","coordinates":[]}', 20 + i * 0.001, 65, 20.0005 + i * 0.001, 65.0005, 'lantmateriet' FROM n;
    INSERT INTO agande (beteckning, orgnr) SELECT beteckning, '5560000003' FROM fastighet WHERE beteckning LIKE 'G %';`);
  db.close();
  const g = await json('/api/bolag/5560000003');
  assert.equal(g.fastigheter.length, 500);
  assert.equal(g.summa.antal, 501);
  assert.equal(g.summa.areal_m2, 5010);
  assert.equal(g.summa.beteckningar.length, 501);
  assert.equal(g.summa.maxx, 20.5015);
});
