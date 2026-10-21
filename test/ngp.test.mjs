import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testaNgp } from '../scripts/testa-ngp.mjs';
import { hamtaNgp, hamtaPlanDokument, ngpPlan, ngpPlaner, sparaNgp } from '../lib/ngp.mjs';
import { openDb } from '../lib/db.mjs';

const feature = (status = 'laga kraft') => ({ type: 'Feature',
  geometry: { type: 'Polygon', coordinates: [[[18, 59], [18.01, 59], [18.01, 59.01], [18, 59]]] },
  properties: { feature: { typ: 'detaljplan' }, detaljplan: { objektidentitet: 'plan-1', typ: 'detaljplan',
    status, namn: 'Exempelplan', beteckning: '0180K-1', datumLagakraft: '2025-01-01' } } });

test('NGP hämtar alla sidor och skickar inte lösenord till främmande sidlänkar', async () => {
  let calls = 0;
  const rows = await hamtaNgp('0180', 'konto', 'lösen', async (url, options) => {
    calls++;
    assert.equal(new URL(url).pathname, '/distribution/geodatakatalog/sokning/v1/detaljplan/v2/search');
    assert.equal(new URL(url).searchParams.get('crs'), 'http://www.opengis.net/def/crs/OGC/1.3/CRS84');
    if (calls === 1) {
      assert.equal(options.method, 'POST');
      assert.equal(new URL(url).searchParams.has('query'), false);
      assert.deepEqual(JSON.parse(options.body), { collections: ['0180'], limit: 100 });
      return Response.json({ type: 'FeatureCollection', features: [feature()], links: [{ rel: 'next', href: '?page=2' }] });
    }
    return Response.json({ type: 'FeatureCollection', features: [feature('samråd')] });
  });
  assert.equal(calls, 2);
  assert.equal(rows.length, 2);
  calls = 0;
  await assert.rejects(hamtaNgp('0180', 'konto', 'lösen', async () => {
    calls++;
    return Response.json({ type: 'FeatureCollection', features: [], links: [{ rel: 'next', href: 'https://example.com/' }] });
  }), /utanför söktjänsten/);
  assert.equal(calls, 1);
});

test('NGP följer POST-sidor med både sammanfogad och ersatt sökkropp', async () => {
  const original = { collections: ['0180'], limit: 100 };
  const expected = [original, { ...original, afterId: 'ett' }, { ...original, afterId: 'två' }];
  let calls = 0;
  const rows = await hamtaNgp('0180', 'konto', 'lösen', async (_url, options) => {
    assert.equal(options.method, 'POST');
    assert.deepEqual(JSON.parse(options.body), expected[calls]);
    const id = ['ett', 'två', 'tre'][calls++];
    return Response.json({ type: 'FeatureCollection', features: [{ id }], links: calls === 3 ? [] : [{
      rel: 'next', href: 'search', method: 'POST', merge: calls === 1,
      body: calls === 1 ? { afterId: 'ett' } : { ...original, afterId: 'två' },
    }] });
  });
  assert.equal(calls, 3);
  assert.deepEqual(rows.map((r) => r.id), ['ett', 'två', 'tre']);
});

test('NGP kopplar bestämmelsetext, värde och delområdets geometri till rätt plan', () => {
  const rule = feature();
  rule.properties.feature = { typ: 'egenskapsbestämmelse', etikett: 'h1' };
  rule.properties.planbestammelse = { bestammelseformulering: 'Högsta nockhöjd är angivet värde.',
    bestammelsevarde: { variabelvarde: 8, vardetyp: 'max', enhet: 'meter' } };
  const [plan] = ngpPlaner([rule, feature()], '0180');
  assert.deepEqual(JSON.parse(plan.bestammelser), [{ typ: 'egenskapsbestämmelse', etikett: 'h1',
    text: 'Högsta nockhöjd är angivet värde.', varde: { tal: 8, typ: 'max', enhet: 'meter' }, geometry: rule.geometry }]);
  const db = openDb({ path: ':memory:' });
  try {
    sparaNgp(db, [plan], '0180');
    assert.equal(db.prepare('SELECT bestammelser FROM plan').get().bestammelser, plan.bestammelser);
  } finally { db.close(); }
  // En bestämmelse vars plan saknas i svaret hoppas över; en utan text stoppar importen.
  assert.deepEqual(ngpPlaner([rule], '0180'), []);
  rule.properties.planbestammelse.bestammelseformulering = ' ';
  assert.throws(() => ngpPlaner([rule, feature()], '0180'), /saknar bestämmelsetext/);
});

test('NGP hämtar dokumentadressen utan att skicka inloggning vidare till dokumentet', async () => {
  const plan = feature();
  plan.assets = { karta: { href: 'https://api.lantmateriet.se/distribution/geodatakatalog/nedladdning/v1/asset/test',
    roles: ['beslutshandling'] } };
  let calls = 0;
  await hamtaPlanDokument([plan], 'konto', 'lösen', async (url, options) => {
    calls++;
    assert.equal(options.redirect, 'manual');
    assert.equal(url, plan.assets.karta.href);
    assert.equal(options.headers.Authorization, `Basic ${Buffer.from('konto:lösen').toString('base64')}`);
    return new Response(null, { status: 303, headers: { Location: 'https://kommun.example/plankarta.pdf' } });
  });
  assert.equal(calls, 1);
  assert.deepEqual(JSON.parse(ngpPlan(plan, '0180').dokument), [{ titel: 'Plankarta', url: 'https://kommun.example/plankarta.pdf' }]);
  await assert.rejects(hamtaPlanDokument([plan], 'konto', 'lösen', async () =>
    new Response(null, { status: 303, headers: { Location: 'javascript:alert(1)' } })), /publik HTTPS/);
});

test('NGP hämtar PDF på den skyddade dataadressen och sparar en lokal dokumentlänk', async () => {
  const plan = feature();
  const base = 'https://api.lantmateriet.se/distribution/geodatakatalog/nedladdning/v1/';
  plan.assets = { karta: { href: base + 'asset/test', roles: ['beslutshandling'] } };
  let calls = 0;
  await hamtaPlanDokument([plan], 'konto', 'lösen', async (url, options) => {
    assert.equal(options.redirect, 'manual');
    calls++;
    if (calls === 1) return new Response(null, { status: 303, headers: { Location: base + 'data/detaljplan/test?r=1' } });
    assert.equal(url, base + 'data/detaljplan/test?r=1');
    return new Response('%PDF-1.7\nTest', { headers: { 'Content-Type': 'application/octet-stream' } });
  }, async (bytes) => {
    assert.equal(bytes.toString(), '%PDF-1.7\nTest');
    return '/plandokument/' + 'a'.repeat(64) + '.pdf';
  });
  assert.equal(calls, 2);
  assert.equal(JSON.parse(ngpPlan(plan, '0180').dokument)[0].url, '/plandokument/' + 'a'.repeat(64) + '.pdf');
});

test('NGP behåller linjer och punkter som egna geometrier', () => {
  const geometries = [{ type: 'LineString', coordinates: [[18, 59], [18.01, 59]] },
    { type: 'Point', coordinates: [18, 59, 9] }];
  const rules = geometries.map((geometry) => {
    const f = feature(); f.geometry = geometry;
    f.properties.feature = { typ: 'egenskapsbestämmelse', etikett: 'Utfart' };
    f.properties.planbestammelse = { bestammelseformulering: 'Utfartsförbud' };
    return f;
  });
  assert.deepEqual(JSON.parse(ngpPlaner([feature(), ...rules], '0180')[0].bestammelser).map((b) => b.geometry), geometries);
  rules[0].geometry.coordinates[0][0] = Infinity;
  assert.throws(() => ngpPlaner([feature(), ...rules], '0180'), /Ogiltig bestämmelsegeometri/);
});

test('NGP sparar om samma plan, arkiverar borttagna planer och validerar geometri', () => {
  const db = openDb({ path: ':memory:' });
  try {
    const plan = ngpPlan(feature(), '0180');
    assert.equal(plan.typ, 'DP');
    assert.equal(plan.minx, 18);
    assert.equal(plan.maxy, 59.01);
    sparaNgp(db, [plan], '0180');
    sparaNgp(db, [ngpPlan(feature('upphävd'), '0180')], '0180');
    assert.equal(db.prepare('SELECT count(*) AS n FROM plan').get().n, 1);
    assert.equal(db.prepare('SELECT status FROM plan').get().status, 'upphävd');
    sparaNgp(db, [], '0180');
    assert.equal(db.prepare('SELECT status FROM plan').get().status, 'arkiverad');
    assert.equal(db.prepare('SELECT count(*) AS n FROM plan').get().n, 1);
    const bad = feature(); bad.geometry.coordinates[0][0][0] = 674000;
    assert.throws(() => ngpPlan(bad, '0180'), /WGS84/);
  } finally { db.close(); }
});

test('NGP-kontrollen autentiserar och räknar tillgängliga samlingar', async () => {
  const count = await testaNgp('konto', 'lösen', async (url, options) => {
    assert.equal(url, 'https://api.lantmateriet.se/distribution/geodatakatalog/sokning/v1/detaljplan/v2/collections');
    assert.equal(options.headers.Authorization, `Basic ${Buffer.from('konto:lösen').toString('base64')}`);
    assert.equal(options.redirect, 'error');
    return Response.json({ collections: [{ id: '0180' }, { id: '1480' }] });
  });
  assert.equal(count, 2);
});

test('NGP-kontrollen förklarar nekad behörighet och felaktiga svar', async () => {
  for (const [status, message] of [[401, /Inloggningen nekades/], [403, /saknar behörighet/], [503, /HTTP 503/]]) {
    await assert.rejects(testaNgp('konto', 'lösen', async () => new Response(null, { status })), message);
  }
  await assert.rejects(testaNgp('konto', 'lösen', async () => Response.json({})), /utan samlingar/);
});

test('NGP-inventeringen räknar planer per kommun och fortsätter efter fel', async () => {
  const { inventeraNgp } = await import('../scripts/inventera-ngp.mjs');
  const { rader, andra } = await inventeraNgp('konto', 'lösen', async (url, options) => {
    if (new URL(url).pathname.endsWith('/collections')) return Response.json({ collections: [{ id: '0180' }, { id: '0114' }, { id: 'test' }] });
    const body = JSON.parse(options.body);
    assert.deepEqual(body.query, { 'feature.typ': { eq: 'detaljplan' } });
    if (body.collections[0] === '0114') return new Response('fel', { status: 500 });
    const gammal = feature(); gammal.properties.detaljplan.datumLagakraft = '1990-05-01';
    return Response.json({ type: 'FeatureCollection', features: [feature(), feature('samråd'), gammal, feature('upphävd')] });
  });
  assert.deepEqual(andra, ['test']);
  assert.deepEqual(rader[0], { kod: '0180', planer: 4, laga_kraft: 2, pagaende: 1, ovriga: 1, aldsta: '1990-05-01', senaste: '2025-01-01' });
  assert.match(rader[1].fel, /HTTP 500/);
});

test('NGP-dokument som inte hämtats i förväg får en länk som servern hämtar vid behov', () => {
  const plan = feature();
  const base = 'https://api.lantmateriet.se/distribution/geodatakatalog/nedladdning/v1/asset/';
  plan.assets = {
    plan: { href: base + '10ca8fdb-b4c6-44ff-ada6-138726d096db', roles: ['detaljplan'] },
    karta: { href: base + '464197d0-22c9-4b2f-a2cf-9b304c1f0707', roles: ['beslutshandling'] },
    beskrivning: { href: base + 'db7d0082-26e4-4d6a-8bdd-1eba5fcc217e', roles: ['planbeskrivning'], publikUrl: 'https://kommun.example/b.pdf' },
    annan: { href: 'https://example.com/asset/464197d0-22c9-4b2f-a2cf-9b304c1f0707', roles: ['beslutshandling'] },
  };
  assert.deepEqual(JSON.parse(ngpPlan(plan, '0180').dokument), [
    { titel: 'Plankarta', url: '/plandokument/ngp/464197d0-22c9-4b2f-a2cf-9b304c1f0707.pdf' },
    { titel: 'Planbeskrivning', url: 'https://kommun.example/b.pdf' },
  ]);
});

test('begränsaren: högst två samtidigt, en i kö, fler avvisas och kön går vidare', async () => {
  const { begransare } = await import('../lib/ngp.mjs');
  const plats = begransare(2, 1);
  let aktiva = 0, max = 0;
  const slapp = [];
  const jobb = () => plats(() => new Promise((resolve) => { max = Math.max(max, ++aktiva); slapp.push(() => { aktiva--; resolve(); }); }));
  const a = jobb(), b = jobb(), c = jobb();
  await assert.rejects(jobb(), (e) => e.full === true);
  await new Promise((r) => setImmediate(r));
  assert.equal(slapp.length, 2);
  slapp.shift()();
  await a;
  await new Promise((r) => setImmediate(r));
  assert.equal(slapp.length, 2);
  slapp.forEach((f) => f());
  await Promise.all([b, c]);
  assert.equal(max, 2);
});
