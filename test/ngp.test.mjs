import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testaNgp } from '../scripts/testa-ngp.mjs';
import { hamtaNgp, ngpPlan, sparaNgp } from '../lib/ngp.mjs';
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
      assert.deepEqual(JSON.parse(options.body), { collections: ['0180'], limit: 100, query: { 'feature.typ': { eq: 'detaljplan' } } });
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
