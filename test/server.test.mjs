// Startar servern mot en liten testdatabas och kontrollerar kartfiltren, affärerna,
// största ägare, grannar och träff-exporten.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { request } from 'node:http';
import { createHmac } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { ROOT, openDb, rebuildFastighetFts } from '../lib/db.mjs';
import { oppnaRegister } from '../lib/ortofoto.mjs';

const DB = join(ROOT, 'data', '_test', 'server-test.sqlite');
const SCENARIO_DB = join(ROOT, 'data', '_test', 'scenario-test.sqlite');
const MFN_DB = join(ROOT, 'data', '_test', 'mfn-test.sqlite');
const MFN_SECRET = 'testhemlighet';
const ORTOFOTO_DB = join(ROOT, 'data', '_test', 'ortofoto-test.sqlite');
const PORT = 3005;
let server;

const rect = (x0, y0, x1, y1) => JSON.stringify({ type: 'Polygon', coordinates: [[[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]] });

before(async () => {
  for (const ext of ['', '-wal', '-shm']) for (const fil of [DB, SCENARIO_DB, MFN_DB, ORTOFOTO_DB]) rmSync(fil + ext, { force: true });
  const db = openDb({ path: DB });
  db.exec(`INSERT INTO bolag (orgnr, namn, jurform, sni, agarkontroll) VALUES
    ('5560000001', 'Alfa AB', 'Aktiebolag', '68201', 'kommun'), ('7690000002', 'Brf Beta', 'Bostadsrättsförening', NULL, 'privat')`);
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
  // Arbetsställen: två på 1:1 (Alfa är störst), ett utan fastighet. Lokaltyp och LOA räknas vid importen
  // (lib/lokaltyp.mjs): kontor 34,5 anställda × 20 m² = 690, butik 2,5 × 40 = 100.
  db.exec(`INSERT INTO arbetsstalle (cfar, orgnr, benamning, sni, bransch, anstkl, adress, beteckning, lokaltyp, loa_m2, reklamsparr) VALUES
    (1, '7690000002', NULL, '47110', 'Livsmedelsbutik', 2, 'Testgatan 2', 'T 1:1', 'Butik', 100, 1),
    (2, '5560000001', 'Alfa City', '62100', 'Dataprogrammering', 5, 'Testgatan 1', 'T 1:1', 'Kontor', 690, 0),
    (3, '5560000001', NULL, NULL, NULL, 3, 'Annangatan 9', NULL, 'Övrigt', 210, 0)`);
  // Förorenat: två objekt på 1:1 (det oklassade ska sorteras efter det med riskklass) och ett cirka 280 m norr om den. Utsatt område cirka 1,1 km öster om 1:1.
  db.exec(`INSERT INTO fororenat (ebh_id, bransch, status, riskklass, lon, lat) VALUES
    (3, 'Grafisk industri', 'Identifiering', NULL, 18.0004, 59.0001),
    (1, 'Kemtvätt', 'Inventering', 2, 18.0005, 59.0002), (2, 'Drivmedelshantering', 'Identifiering', NULL, 18.0005, 59.003)`);
  db.prepare("INSERT INTO utsatt_omrade (id, namn, kategori, ort, datum, geojson) VALUES (1, 'Testområdet', 'Utsatt område', 'Testort', '2025-12-01', ?)")
    .run(rect(18.020, 59.000, 18.030, 59.001));
  const insPlan = db.prepare(`INSERT INTO plan (id, typ, geojson, minx, miny, maxx, maxy, kalla, status)
    VALUES (?, 'DP', ?, 18, 59, 18.002, 59.001, 'ngp', ?)`);
  for (const status of ['laga kraft', 'samråd', 'upphävd', 'arkiverad']) {
    insPlan.run(`ngp:${status}`, rect(18, 59, 18.002, 59.001), status);
  }
  db.prepare(`INSERT INTO plan (id, typ, geojson, minx, miny, maxx, maxy, kalla, status)
    VALUES ('ngp:liten', 'DP', ?, 18.0002, 59.0001, 18.00021, 59.00011, 'ngp', 'laga kraft')`)
    .run(rect(18.0002, 59.0001, 18.00021, 59.00011));
  db.close();
  // Ortofotoregistret: en bild över 18,00–18,05 / 59,00–59,03.
  const reg = oppnaRegister(ORTOFOTO_DB, { skriv: true });
  reg.prepare(`INSERT INTO bild (id, namn, samling, href, datum, upplosning, ruta, geometri, minx, miny, maxx, maxy)
    VALUES (1, 'test', 'orto-test', 'https://example.invalid/test.tif', '2025-05-01', 0.16, '0,0,1,1', ?, 18, 59, 18.05, 59.03)`)
    .run(rect(18, 59, 18.05, 59.03));
  reg.exec('INSERT INTO bild_rtree VALUES (1, 18, 18.05, 59, 59.03)');
  reg.close();

  server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', join(ROOT, 'server.mjs')], {
    env: { ...process.env, PORT: String(PORT), FASTIGHETSKARTA_DB: DB, SCENARIO_DB, MFN_DB, MFN_SECRET, ORTOFOTO_DB, GEOTORGET_USER: 'test', GEOTORGET_PASS: 'test', PUBLIC_MODE: '', RATE_SPARA: '50', RATE_EXPORT: '50' },
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

test('NGP: kartans planlager och fastighetspanelen visar pågående och gällande planer med status', async () => {
  const plans = await json(`/api/planer?${BBOX}`);
  assert.deepEqual(plans.features.map((f) => f.properties.id).sort(), ['ngp:laga kraft', 'ngp:liten', 'ngp:samråd']);
  const f = await json('/api/fastighet/' + encodeURIComponent('T 1:1'));
  assert.deepEqual(f.planer.map((p) => p.id).sort(), ['ngp:laga kraft', 'ngp:liten', 'ngp:samråd']);
  assert.equal(f.planer.find((p) => p.id === 'ngp:samråd').status, 'samråd');
  assert.equal(f.planer[0].kalla, 'ngp');
});

test('kartfiltren', async () => {
  assert.equal(await antal(''), 3);
  assert.equal(await antal('&jur=Bostadsrättsförening'), 1);
  assert.equal(await antal('&vmin=100'), 1);            // Mkr
  assert.equal(await antal('&vmin=99,5'), 1);           // decimalkomma
  assert.equal(await antal('&vmin=1%20000'), 0);        // mellanslag mellan tusental
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
  assert.equal(await antal('&agkat=fastighetsbolag'), 0);   // Alfa AB har SNI 68201 men är kommunalt ägt (SCB)
  assert.equal(await antal('&agkat=ovriga'), 0);
  assert.equal(await antal('&agkat=kommun'), 2);
  assert.equal(await antal('&lok=Industri'), 0);
  assert.equal(await antal('&loamin=700'), 1);
  assert.equal(await antal('&loamin=800'), 0);
  assert.equal(await antal('&loamax=800'), 1);       // fastigheter utan uppskattad LOA räknas inte
  assert.equal(await antal('&vmin=abc&kar=20x'), 3);    // ogiltiga värden ignoreras
  assert.equal(await antal('&kar=2021&vmin=100'), 1);
  assert.equal((await get('/api/fastigheter')).status, 400);
});

test('ortofoto: täckning och zoomgränser', async () => {
  assert.deepEqual((await json('/api/status')).ortofoto, [18, 59, 18.05, 59.03]);
  assert.equal((await get('/tiles/ortofoto/13/4600/2400.webp')).status, 404);    // under zoom 14
  assert.equal((await get('/tiles/ortofoto/19/1/1.webp')).status, 404);          // över zoom 18 (~0,3 m)
  assert.equal((await get('/tiles/ortofoto/16/0/0.webp')).status, 404);          // utanför registret
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

test('kommunkluster räknar med filtren i hela landet', async () => {
  const [[lon, lat, kommun, n, tkr]] = (await json('/api/kommunkluster')).k;
  assert.deepEqual([kommun, n, tkr], ['Testkommun', 3, 260000]);
  assert.ok(lon > 18 && lon < 18.011 && lat > 59 && lat < 59.0005);
  assert.equal((await json('/api/kommunkluster?anv=Hyreshusenhet%2C%20lokaler')).k[0][3], 2);
  assert.deepEqual((await json('/api/kommunkluster?kommun=Annan')).k, []);
});

test('pressmeddelanden i Affärer och på fastigheten', async () => {
  const db = openDb({ path: DB });
  db.exec(`INSERT INTO nyhet (url, kalla, utgivare, rubrik, datum, typ, pris_kr, kommun) VALUES
    ('https://news.cision.com/se/a/r/1', 'cision', 'Alfa AB', 'Alfa köper från privatpersonen Test Testsson', '2026-09-01T06:00:00Z', 'kop', 300000000, 'Testkommun');
    INSERT INTO nyhet_plats (url, beteckning, adress, lon, lat) VALUES
    ('https://news.cision.com/se/a/r/1', 'T 1:1', NULL, NULL, NULL), ('https://news.cision.com/se/a/r/1', 'FINNS INTE 1', NULL, NULL, NULL)`);
  db.close();
  const [n] = (await json('/api/affarer')).nyheter;
  assert.deepEqual([n.dag, n.beteckningar, n.minx, n.maxx], ['2026-09-01', ['T 1:1'], 18.000, 18.001]);
  assert.equal((await json('/api/fastighet/T%201%3A1')).nyheter[0].rubrik, 'Alfa AB meddelar fastighetsköp för 300 000 000 kr');
  assert.deepEqual((await json('/api/fastighet/T%201%3A2')).nyheter, []);
});

test('samma affär i en tidning och ett pressmeddelande visas en gång; tidningen blir aldrig köpare', async () => {
  const db = openDb({ path: DB });
  db.exec(`INSERT INTO bolag (orgnr, namn) VALUES ('5560000009', 'Fastighetsvärlden');
    INSERT INTO nyhet (url, kalla, utgivare, rubrik, datum, typ, pris_kr, kommun) VALUES
    ('https://www.fastighetsvarlden.se/notiser/1/', 'fastighetsvarlden', 'Fastighetsvärlden', 'x', '2026-09-03T06:00:00Z', 'kop', 300000000, NULL),
    ('https://www.fastighetsvarlden.se/notiser/2/', 'fastighetsvarlden', 'Fastighetsvärlden', 'x', '2026-09-20T06:00:00Z', 'kop', 300000000, NULL),
    ('https://www.fastighetsvarlden.se/notiser/3/', 'fastighetsvarlden', 'Fastighetsvärlden', 'x', '2026-09-02T06:00:00Z', 'kop', NULL, NULL),
    ('https://www.fastighetsnytt.se/artikel/4', 'fastighetsnytt', 'Fastighetsnytt', 'x', '2026-09-21T06:00:00Z', 'kop', 300000000, NULL);
    INSERT INTO nyhet (url, kalla, utgivare, rubrik, datum, typ, pris_kr, kommun, aktor_orgnr) VALUES
    ('https://www.fastighetsvarlden.se/notiser/7/', 'fastighetsvarlden', 'Fastighetsvärlden', 'x', '2026-08-01T06:00:00Z', 'salj', NULL, NULL, '5560000001')`);
  db.close();
  const n7 = (await json('/api/affarer')).nyheter.find((n) => n.url.endsWith('/7/'));
  assert.deepEqual([n7.rubrik, n7.aktor_orgnr], ['Fastighetsförsäljning av Alfa AB', undefined]);   // aktören från importen
  const urls = (await json('/api/affarer')).nyheter.map((n) => n.url);
  // 1 är samma affär som Alfas pressmeddelande (samma pris, två dagar senare); 2 är för långt ifrån, 3 saknar pris;
  // 4 är samma affär som 2 i en annan tidning, en dag senare.
  assert.ok(!urls.includes('https://www.fastighetsvarlden.se/notiser/1/') && !urls.includes('https://www.fastighetsnytt.se/artikel/4'));
  assert.ok(urls.includes('https://www.fastighetsvarlden.se/notiser/2/') && urls.includes('https://www.fastighetsvarlden.se/notiser/3/'));
  const n2 = (await json('/api/affarer')).nyheter.find((n) => n.url.endsWith('/2/'));
  assert.equal(n2.rubrik, `Fastighetsköp för ${(300e6).toLocaleString('sv-SE')} kr`);   // inte "Fastighetsvärlden meddelar …"
});

test('dubbletter: olika kommuner är olika affärer; fastighetspanelen döljer bara det som ersätts där', async () => {
  const db = openDb({ path: DB });
  db.exec(`INSERT INTO nyhet (url, kalla, utgivare, rubrik, datum, typ, pris_kr, kommun) VALUES
    ('https://www.fastighetsvarlden.se/notiser/5/', 'fastighetsvarlden', 'Fastighetsvärlden', 'x', '2026-09-02T06:00:00Z', 'kop', 300000000, 'Uppsala'),
    ('https://news.cision.com/se/a/r/2', 'cision', 'Alfa AB', 'x', '2026-10-01T06:00:00Z', 'kop', 50000000, NULL),
    ('https://www.fastighetsvarlden.se/notiser/6/', 'fastighetsvarlden', 'Fastighetsvärlden', 'x', '2026-10-02T06:00:00Z', 'kop', 50000000, NULL);
    INSERT INTO nyhet_plats (url, beteckning, adress, lon, lat) VALUES ('https://www.fastighetsvarlden.se/notiser/6/', 'T 1:2', NULL, NULL, NULL)`);
  db.close();
  const urls = (await json('/api/affarer')).nyheter.map((n) => n.url);
  assert.ok(urls.includes('https://www.fastighetsvarlden.se/notiser/5/'));    // Uppsala, inte Alfas köp i Testkommun
  assert.ok(!urls.includes('https://www.fastighetsvarlden.se/notiser/6/'));   // samma affär som Alfas pressmeddelande 2
  // Pressmeddelande 2 är inte kopplat till T 1:2, så notisen är det enda som visas där.
  assert.deepEqual((await json('/api/fastighet/T%201%3A2')).nyheter.map((n) => n.url), ['https://www.fastighetsvarlden.se/notiser/6/']);
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

test('sök transaktioner', async () => {
  const sok = async (s, extra = '') => (await json(`/api/affarer?sok=${encodeURIComponent(s)}${extra}`)).traffar?.map((r) => r.dag);
  assert.deepEqual(await sok('t 1:3'), ['2024-05-01']);          // andra fastigheten i paketaffären
  assert.deepEqual(await sok('ALFA'), ['2024-05-01']);
  assert.deepEqual(await sok('769000-0002'), ['2020-01-01']);    // org.nr med bindestreck
  assert.deepEqual(await sok('brf beta'), ['2020-01-01']);
  assert.deepEqual(await sok('beta', '&min=100'), []);           // köpeskillingsfiltret gäller
  assert.deepEqual(await sok('gamma'), []);
  assert.equal(await sok('a'), undefined);                       // minst två tecken

  // Paket med fastigheter i två kommuner och olika säljare: hela paketet är sökbart, även med kommunfilter.
  const db = openDb({ path: DB });
  db.exec(`INSERT INTO bolag (orgnr, namn) VALUES ('5560000011', 'Nordhus AB'), ('5560000012', 'Sydhem AB');
    INSERT INTO fastighet (beteckning, kommun, geojson, minx, miny, maxx, maxy, kalla) VALUES
      ('P 1:1', 'Testkommun', '{}', 21, 66, 21.001, 66.001, 'lantmateriet'), ('P 1:2', 'Annankommun', '{}', 21.01, 66, 21.011, 66.001, 'lantmateriet');
    INSERT INTO transaktion (beteckning, inskrivningsdag, kopeskilling_kr, forvarvare_orgnr) VALUES
      ('P 1:1', '2015-01-01', 1000000, '5560000011'), ('P 1:2', '2015-01-01', 1000000, '5560000012'),
      ('P 1:1', '2022-06-01', 50000000, '5560000001'), ('P 1:2', '2022-06-01', 50000000, '5560000001')`);
  try {
    assert.deepEqual(await sok('sydhem'), ['2022-06-01', '2015-01-01']);   // säljaren av den andra fastigheten
    const [paket] = (await json('/api/affarer?sok=p%201%3A2&kommun=Testkommun')).traffar;
    assert.deepEqual([paket.dag, paket.beteckning, paket.antal, paket.saljare], ['2022-06-01', 'P 1:1', 2, 'Nordhus AB']);
    assert.deepEqual(await sok('p 1:2', '&kommun=Testkommun'), ['2022-06-01']);   // köpet 2015 ligger bara i Annankommun
  } finally {
    db.exec(`DELETE FROM transaktion WHERE beteckning LIKE 'P %'; DELETE FROM fastighet WHERE beteckning LIKE 'P %';
      DELETE FROM bolag WHERE orgnr IN ('5560000011', '5560000012')`);
    db.close();
  }
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

test('fastighet: förorenade och utsatta områden med avstånd', async () => {
  const f = await json(`/api/fastighet/${encodeURIComponent('T 1:1')}`);
  assert.deepEqual(f.fororenade.map((x) => [x.ebh_id, x.avstand_m, x.riskklass]), [[1, 0, 2], [3, 0, null]]);
  assert.deepEqual(f.utsatta.map((u) => u.namn), ['Testområdet']);
  assert.ok(Math.abs(f.utsatta[0].avstand_m - 1118) < 20, `avstånd ${f.utsatta[0].avstand_m}`);
  assert.equal(f.utsatta[0].geom, undefined);
});

test('företag på adressen och bolagets arbetsställen', async () => {
  const f = await json(`/api/fastighet/${encodeURIComponent('T 1:1')}`);
  // Reklamspärren måste följa med: SCB:s villkor kräver att den visas.
  assert.deepEqual(f.hyresgaster.map((h) => [h.namn, h.benamning, h.anstkl, h.adress, h.reklamsparr]),
    [['Alfa AB', 'Alfa City', 5, 'Testgatan 1', 0], ['Brf Beta', null, 2, 'Testgatan 2', 1]]);
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

const post = (path, body, typ = 'application/json') =>
  fetch(`http://127.0.0.1:${PORT}${path}`, { method: 'POST', headers: { 'content-type': typ }, body: typeof body === 'string' ? body : JSON.stringify(body) });

test('scenarier: underlag för fastigheterna', async () => {
  const r = await post('/api/underlag', { bet: ['t 1:1', 'T 1:2', 'FINNS INTE 1'] }).then((x) => x.json());
  const t11 = r.fastigheter.find((f) => f.beteckning === 'T 1:1');
  assert.equal(r.fastigheter.length, 2);
  assert.deepEqual([t11.varde_tkr, t11.typ, t11.upplatelse, t11.loa], [50000, 'Hyreshusenhet, lokaler', 'tomtratt', { Butik: 100, Kontor: 690 }]);
  assert.equal((await post('/api/underlag', { bet: 'T 1:1' })).status, 400);
  assert.equal((await get('/api/underlag')).status, 405);
});

test('scenarier: korta länkar', async () => {
  const sc = { v: 1, namn: 'Test', start: 2026, ar: 5, bet: ['T 1:1'], gemensamt: { hyresutv: 2 }, antaganden: { Kontor: { hyra: 2000 } }, egna: {} };
  const { id } = await post('/api/scenario', sc).then((r) => r.json());
  assert.match(id, /^[A-Za-z0-9_-]{10}$/);
  assert.equal((await post('/api/scenario', sc).then((r) => r.json())).id, id);   // samma innehåll, samma länk
  assert.deepEqual(await json(`/api/scenario/${id}`), sc);
  assert.equal((await get('/api/scenario/xxxxxxxxxx')).status, 404);
  assert.equal((await post('/api/scenario', sc, 'text/plain')).status, 415);   // ett formulär från en annan sida
  assert.equal((await post('/api/scenario', '{inte json')).status, 400);
  assert.equal((await post('/api/scenario', { ...sc, v: 2 })).status, 400);
  assert.equal((await post('/api/scenario', { ...sc, namn: 'x'.repeat(101) })).status, 400);
  assert.equal((await post('/api/scenario', { ...sc, egna: { a: { b: { c: { d: { e: { f: 1 } } } } } } })).status, 400);   // för djupt
  // Delscenarier (Addera): delar[i].egna[bet].yta[slag] är det djupaste som ska gå igenom.
  assert.equal((await post('/api/scenario', { ...sc, delar: [{ namn: 'B', bet: ['T 1:2'], egna: { 'T 1:2': { yta: { Kontor: 100 } } } }] })).status, 200);
  assert.equal((await post('/api/scenario', { ...sc, bet: Array(1001).fill('T 1:1') })).status, 400);
  assert.equal((await post('/api/scenario', { ...sc, namn: 'x'.repeat(300_000) })).status, 413);
  assert.equal((await json('/api/status')).kortlankar, true);
});

test('MFN: signerade pressmeddelanden tas emot, affärer sparas med org.nr och aldrig texten', async () => {
  const skicka = (item, hemlighet = MFN_SECRET) => {
    const kropp = JSON.stringify(item);
    return fetch(`http://127.0.0.1:${PORT}/api/mfn`, { method: 'POST', body: kropp, headers: {
      'content-type': 'application/json', 'x-hub-signature': `sha256=${createHmac('sha256', hemlighet).update(kropp).digest('hex')}` } });
  };
  const item = (url, title, orgnr = '556000-0001') => ({ url, author: { name: 'Alfa AB', local_refs: [`SE:${orgnr}`] }, properties: { lang: 'sv', type: 'ir' },
    content: { title, text: 'Fastigheten Pilen 1 i Uppsala. Hemlig brödtext.', publish_date: '2026-10-12T06:00:00Z' } });
  const affar = item('https://mfn.se/a/alfa/1', 'Alfa förvärvar fastighet i Uppsala för 50 mkr');
  assert.equal((await skicka(affar, 'fel')).status, 403);
  assert.deepEqual(await skicka(affar).then((r) => r.json()), { sparad: true });
  assert.deepEqual(await skicka(item('https://mfn.se/a/alfa/2', 'Alfa publicerar delårsrapport')).then((r) => r.json()), { sparad: false });
  // Även andra bolags affärer sparas; importen (cron) tar bara med fastighetsbolagens.
  assert.deepEqual(await skicka(item('https://mfn.se/a/x/3', 'X förvärvar konsultbolag i Uppsala för 50 mkr', '556999-9999')).then((r) => r.json()), { sparad: true });
  assert.equal(await get('/api/mfn?hub.mode=subscribe&hub.challenge=abc123').then((r) => r.text()), 'abc123');
  assert.equal((await get('/api/mfn')).status, 400);
  const mdb = new DatabaseSync(MFN_DB, { readOnly: true });
  const rader = mdb.prepare('SELECT * FROM mfn_nyhet').all();
  mdb.close();
  assert.deepEqual(rader.map((r) => [r.url, r.typ, r.pris_kr, r.kommun, r.orgnr]),
    [['https://mfn.se/a/alfa/1', 'kop', 50e6, 'Uppsala', '5560000001'], ['https://mfn.se/a/x/3', 'kop', 50e6, 'Uppsala', '5569999999']]);
  assert.ok(!JSON.stringify(rader).includes('Hemlig'));
});

test('inläsning från fil: beteckning och kommun krävs, kommunen från kolumnen eller först i beteckningen', async () => {
  const db = openDb({ path: DB });
  // En fastighet i en riktig kommun, långt från de andra (påverkar inga bbox-tester).
  db.prepare("INSERT INTO fastighet (beteckning, kommun, areal_m2, geojson, minx, miny, maxx, maxy, kalla) VALUES ('SOLNA R 1:1', 'Solna', 100, ?, 25, 66, 25.001, 66.0005, 'lantmateriet')")
    .run(rect(25, 66, 25.001, 66.0005));
  db.close();
  const rader = [{ bet: 'r 1:1', kommun: 'Solna' }, { bet: 'Solna R 1:1' }, { bet: 'R 1:1', kommun: 'SOLNA KOMMUN' },
    { bet: 'R 1:1' }, { bet: 'R 1:1', kommun: 'Sundbyberg' }, { bet: 'T 1:1', kommun: 'Testkommun' }, { adress: 'Ingen gata 1' }, {}];
  const r = await post('/api/matcha', { rader }).then((x) => x.json());
  assert.deepEqual(r.traffar.map((t) => [t.beteckning, t.orsak ?? null]), [['SOLNA R 1:1', null], ['SOLNA R 1:1', null], ['SOLNA R 1:1', null],
    [null, 'kommun'], [null, 'okand'], [null, 'kommun'], [null, 'kommun'], [null, 'kommun']]);   // Testkommun är ingen riktig kommun
  assert.equal(r.traffar[0].via, 'beteckning');
  assert.equal((await post('/api/matcha', { rader: Array(1001).fill({ bet: 'R 1:1' }) })).status, 400);
  assert.equal((await post('/api/matcha', { rader: 'R 1:1' })).status, 400);
});

test('ogiltig URL ger 400 och servern fortsätter svara', async () => {
  const status = await new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: PORT, path: '//[' }, (res) => {
      res.resume(); res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject); req.end();
  });
  assert.equal(status, 400);
  assert.equal((await get('/api/status')).status, 200);
});

test('taxeringsvärde räknar varje enhet en gång och behåller båda ägarna', async () => {
  const db = openDb({ path: DB });
  db.exec("UPDATE taxering SET taxeringsenhet = 'TE1', agare_orgnr = '7690000002' WHERE beteckning = 'T 1:2';"
    + "INSERT INTO taxering (beteckning, taxeringsenhet, ar, varde_tkr, agare_orgnr) VALUES"
    + "('T 1:2', 'TE1', 2025, 10000, '5560000001'), ('T 1:2', 'TE2', 2025, 10000, '5560000001')");
  try {
    const f = await json('/api/fastighet/T%201%3A2');
    assert.equal(f.taxering.reduce((s, t) => s + (t.varde_tkr ?? 0), 0), 20000);
    assert.deepEqual([...new Set(f.taxering.map((t) => t.agare_orgnr))].sort(), ['5560000001', '7690000002']);
    const u = await post('/api/underlag', { bet: ['T 1:2'] }).then((r) => r.json());
    assert.equal(u.fastigheter[0].varde_tkr, 20000);
    assert.equal((await json('/api/fastigheter?' + BBOX)).features.find((f) => f.properties.beteckning === 'T 1:2').properties.varde_tkr, 20000);
    assert.match(await get('/data/horos-fastigheter.csv').then((r) => r.text()), /T 1:2;Testkommun;500;[^\r\n]*;2025;20000;/);
  } finally {
    db.exec("DELETE FROM taxering WHERE beteckning = 'T 1:2' AND agare_orgnr = '5560000001';"
      + "UPDATE taxering SET taxeringsenhet = NULL, agare_orgnr = NULL WHERE beteckning = 'T 1:2'"); db.close();
  }
});

test('anonym överlåtelse bryter säljarkedjan och listas aldrig som en publik affär', async () => {
  const db = openDb({ path: DB });
  const gamla = db.prepare("SELECT * FROM transaktion WHERE beteckning = 'T 1:2'").all();
  db.exec("DELETE FROM transaktion WHERE beteckning = 'T 1:2'; INSERT INTO transaktion (beteckning, inskrivningsdag, kopeskilling_kr, forvarvare_orgnr) VALUES"
    + "('T 1:2', '2018-01-01', 1000000, '5560000001'), ('T 1:2', '2020-01-01', 2000000, NULL), ('T 1:2', '2026-01-01', 3000000, '7690000002')");
  try {
    const a = await json('/api/affarer?ar=2026');
    const kop = a.senaste.find((x) => x.beteckning === 'T 1:2');
    assert.equal(kop.saljare_orgnr, null); assert.equal(kop.saljare, null);
    assert.ok(!a.arLista.includes('2020'));
    assert.ok(!(await json('/api/bolag/5560000001')).salt.some((x) => x.beteckning === 'T 1:2'));
    const f = await json('/api/fastighet/T%201%3A2');
    assert.deepEqual(f.transaktioner.map((x) => x.privat ? x : x.forvarvare_orgnr), ['7690000002', { privat: true }, '5560000001']);
    assert.doesNotMatch(JSON.stringify(f.transaktioner), /2020-01-01|2000000/);
    const grannen = await json('/api/fastighet/T%201%3A1');
    assert.ok(!grannen.narKop.some((x) => x.beteckning === 'T 1:2' && x.dag === '2020-01-01'));
    const rutter = ['/api/status', '/api/affarer', '/api/bolag/5560000001', '/api/bolag/7690000002',
      '/api/fastighet/T%201%3A1', '/api/fastigheter?' + BBOX, '/api/punkter?' + BBOX,
      '/api/fastigheter?' + BBOX + '&kar=2030&kmin=900', '/api/punkter?' + BBOX + '&kar=2030&kmin=900',
      '/api/kommunkluster?kar=2030&kmin=900', '/data/horos-traffar.csv?' + BBOX, '/data/horos-fastigheter.csv'];
    const svar = () => Promise.all(rutter.map(async (p) => { const r = await get(p); assert.equal(r.status, 200, p); return r.text(); }));
    const fore = await svar();
    db.exec("INSERT INTO transaktion (beteckning, inskrivningsdag, kopeskilling_kr, forvarvare_orgnr) VALUES ('T 1:2', '2031-02-03', 987654321, NULL)");
    assert.deepEqual(await svar(), fore);
    const senaste = (await json('/api/fastighet/T%201%3A2')).transaktioner;
    assert.deepEqual(senaste[0], { privat: true });
    assert.deepEqual(senaste[2], { privat: true });
    assert.doesNotMatch(JSON.stringify(senaste), /2031-02-03|987654321|2020-01-01|2000000/);
  } finally {
    db.exec("DELETE FROM transaktion WHERE beteckning = 'T 1:2'");
    const ins = db.prepare('INSERT INTO transaktion (beteckning, inskrivningsdag, kopeskilling_kr, forvarvare_orgnr, art, andel, demo) VALUES (?, ?, ?, ?, ?, ?, ?)');
    for (const r of gamla) ins.run(r.beteckning, r.inskrivningsdag, r.kopeskilling_kr, r.forvarvare_orgnr, r.art, r.andel, r.demo);
    db.close();
  }
});

test('serverns CSV-exporter skyddar bolagsnamn från Excel-formler', async () => {
  const db = openDb({ path: DB }); db.exec("UPDATE bolag SET namn = '=1+1' WHERE orgnr = '5560000001'");
  try {
    for (const path of ['/data/horos-fastigheter.csv', '/data/horos-traffar.csv?' + BBOX]) {
      const r = await get(path); assert.equal(r.status, 200);
      const text = await r.text(); assert.match(text, /;'=1\+1;/); assert.doesNotMatch(text, /;=1\+1;/);
    }
  } finally { db.exec("UPDATE bolag SET namn = 'Alfa AB' WHERE orgnr = '5560000001'"); db.close(); }
});

test('fastighetssökning hittar pilen 1 utan kommunprefix via FTS', async () => {
  const db = openDb({ path: DB });
  db.exec("INSERT INTO fastighet (beteckning, kommun, geojson, kalla) VALUES"
    + "('STOCKHOLM PILEN 1', 'Stockholm', '{}', 'lantmateriet'), ('SOLNA PILEN 10', 'Solna', '{}', 'lantmateriet'), ('STOCKHOLM PILEN 2', 'Stockholm', '{}', 'lantmateriet')");
  rebuildFastighetFts(db);
  try {
    const r = await json('/api/sok?q=pilen%201');
    assert.deepEqual(r.fastigheter.map((f) => f.beteckning).sort(), ['SOLNA PILEN 10', 'STOCKHOLM PILEN 1']);
    assert.deepEqual((await json('/api/sok?q=stockholm%20pilen%201')).fastigheter.map((f) => f.beteckning), ['STOCKHOLM PILEN 1']);
    assert.deepEqual((await json('/api/sok?q=5560000001')).fastigheter, []);
  } finally { db.exec("DELETE FROM fastighet WHERE beteckning LIKE '% PILEN %'"); rebuildFastighetFts(db); db.close(); }
});
