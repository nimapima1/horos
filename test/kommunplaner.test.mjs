import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../lib/db.mjs';
import { datum, plantyp, esriTillGeojson, rensaGeometri, hamtaKommunplaner, utanNgpDubbletter, sparaKommunplaner } from '../lib/kommunplaner.mjs';

test('datum: bara tydliga datum, år när källan bara har året', () => {
  assert.equal(datum('19890525'), '1989-05-25');
  assert.equal(datum(20170818), '2017-08-18');
  assert.equal(datum('2000-11-01'), '2000-11-01');
  assert.equal(datum('2026-03-12 10:22'), '2026-03-12');
  assert.equal(datum(2008), '2008');
  assert.equal(datum(-1322956800000), '1928-01-30');
  assert.equal(datum(1458777600000), '2016-03-24');
  for (const v of [null, '', ' ', '0201-08-02', 'okänt']) assert.equal(datum(v), null);
});

test('plantyp: klartext och kommunernas koder', () => {
  const fall = { Byggnadsplan: 'BPL', 'ws-Detaljplan:Byggnadsplaner': 'BPL', 'ws-Detaljplan:Stadsplaner': 'SPL', PLANSPL: 'SPL',
    DP4000: 'DP', 'BPL - Antagen 19651125': 'BPL', 'ÄDP Antagen 19900807': 'ÄDP', 'Ändring av DP': 'ÄDP', PLANÄDP: 'ÄDP',
    PLANOB: 'OB', 'Ändring av områdesbestämmelse': 'ÄOB', Tomtindelning: 'TI', Detaljplan: 'DP', 7: 'DP' };
  for (const [v, typ] of Object.entries(fall)) assert.equal(plantyp(v), typ, v);
  assert.equal(plantyp(null), 'DP');
});

test('esri-polygoner: medurs ringar är ytor, moturs är hål', () => {
  const yttre = [[18, 59], [18, 59.1], [18.1, 59.1], [18.1, 59], [18, 59]];
  const hal = [[18.02, 59.02], [18.08, 59.02], [18.08, 59.08], [18.02, 59.08], [18.02, 59.02]];
  const andra = [[19, 59], [19, 59.1], [19.1, 59.1], [19.1, 59], [19, 59]];
  assert.deepEqual(esriTillGeojson({ rings: [yttre, hal] }), { type: 'Polygon', coordinates: [yttre, hal] });
  assert.deepEqual(esriTillGeojson({ rings: [yttre, andra] }), { type: 'MultiPolygon', coordinates: [[yttre], [andra]] });
});

test('geometrin: lat/lon vänds, z tas bort, utanför Sverige eller öppen ring avvisas', () => {
  const ring = [[59, 18, 1], [59.1, 18, 1], [59.1, 18.1, 1], [59, 18, 1]];
  assert.deepEqual(rensaGeometri({ type: 'Polygon', coordinates: [ring] }).coordinates[0][1], [18, 59.1]);
  assert.equal(rensaGeometri({ type: 'Polygon', coordinates: [[[2, 48], [2.1, 48], [2.1, 48.1], [2, 48]]] }), null);
  assert.equal(rensaGeometri({ type: 'Polygon', coordinates: [[[18, 59], [18.1, 59], [18.1, 59.1], [18, 59.2]]] }), null);
  assert.equal(rensaGeometri({ type: 'LineString', coordinates: [[18, 59], [18.1, 59]] }), null);
});

test('hämtning från ArcGIS: alla objekt i omgångar, fält och dokumentlänkar enligt inställningen', async () => {
  const anrop = [];
  const ring = [[13, 55.6], [13, 55.61], [13.01, 55.61], [13.01, 55.6], [13, 55.6]];
  const { rader } = await hamtaKommunplaner('1280', async (url) => {
    anrop.push(url);
    if (url.includes('returnIdsOnly')) return Response.json({ objectIdFieldName: 'OBJECTID', objectIds: [1, 2] });
    assert.match(url, /objectIds=1,2&outFields=\*&outSR=4326/);
    return Response.json({ objectIdFieldName: 'OBJECTID', features: [
      { attributes: { OBJECTID: 1, LMAKT: '1280K-DP4000', PLANNAMN: 'ROSENHOLMS HANDELSTRÄDGÅRD', FIX_LAGAKR: '19890525', PLAN_: 'DP4000',
        url_1: 'https://kartor.malmo.se/Planvisaren?plan=dp4000_1.pdf', url_dok: ' ' }, geometry: { rings: [ring] } },
      { attributes: { OBJECTID: 2, LMAKT: 'x' }, geometry: { rings: [[[0, 0], [0, 1], [1, 1], [0, 0]]] } },
    ] });
  });
  assert.equal(anrop.length, 2);
  assert.match(anrop[0], /^https:\/\/gis\.malmo\.se\/arcgis\/rest\/services\/SEPlan\/Gallande_planer\/MapServer\/1\/query/);
  assert.equal(rader.length, 1);
  assert.deepEqual({ ...rader[0], geojson: undefined, minx: undefined, miny: undefined, maxx: undefined, maxy: undefined }, {
    id: 'kommun:1280:1:1', typ: 'DP', planid: '1280K-DP4000', namn: 'ROSENHOLMS HANDELSTRÄDGÅRD', datum: '1989-05-25', kommun: '1280',
    geojson: undefined, minx: undefined, miny: undefined, maxx: undefined, maxy: undefined,
    dokument: null });
});

test('hämtning från WFS: varje lager ger sin plantyp, upphävda och fel svar stoppas', async () => {
  const geometry = { type: 'Polygon', coordinates: [[[14, 56.5], [14.01, 56.5], [14.01, 56.51], [14, 56.5]]] };
  const { rader } = await hamtaKommunplaner('0767', async (url) => {
    const lager = new URL(url).searchParams.get('typeNames');
    return Response.json({ type: 'FeatureCollection', numberMatched: 1,
      features: [{ id: lager + '.1', properties: { BESKRIV: '0767-P93/4', PLANNAMN: 'MARKARYD,KV GULLVIVAN' }, geometry }] });
  });
  assert.deepEqual(rader.map((r) => r.typ), ['DP', 'SPL', 'BPL']);
  await assert.rejects(hamtaKommunplaner('0767', async () => Response.json({ type: 'FeatureCollection', numberMatched: 5, features: [] })), /bara 0 av 5/);
  const huddinge = await hamtaKommunplaner('0126', async () => Response.json({ type: 'FeatureCollection', features: [
    { id: 1, properties: { dp_plantyp: 'Stadsplan', dp_upphavd: '2001-01-01' }, geometry },
    { id: 2, properties: { dp_plantyp: 'Stadsplan', dp_plannummer: '0126K-1' }, geometry }] }));
  assert.deepEqual(huddinge.rader.map((r) => r.planid), ['0126K-1']);
});

test('dubbletter mot NGP och arkivering vid ny import', () => {
  const db = openDb({ path: ':memory:' });
  try {
    const geo = JSON.stringify({ type: 'Polygon', coordinates: [[[18, 59], [18.01, 59], [18.01, 59.01], [18, 59]]] });
    db.prepare(`INSERT INTO plan (id, typ, kommun, geojson, minx, miny, maxx, maxy, kalla, status) VALUES ('ngp:1', 'DP', '1280', ?, 18, 59, 18.01, 59.01, 'ngp', 'laga kraft')`).run(geo);
    const rad = (id, dx) => ({ id, typ: 'DP', planid: null, namn: null, datum: null, kommun: '1280', geojson: geo,
      minx: 18 + dx, miny: 59, maxx: 18.01 + dx, maxy: 59.01, dokument: null });
    db.prepare(`INSERT INTO plan (id, typ, kommun, geojson, minx, miny, maxx, maxy, kalla, status) VALUES ('ngp:2', 'DP', '1280', ?, 18.05, 59, 18.06, 59.01, 'ngp', 'samråd')`).run(geo);
    const nya = utanNgpDubbletter(db, [rad('kommun:1280:1:1', 0.0001), rad('kommun:1280:1:2', 0.01), rad('kommun:1280:1:5', 0.05)], '1280');
    // Samma yta som en gällande NGP-plan tas bort; samma yta som ett NGP-förslag behålls.
    assert.deepEqual(nya.map((r) => r.id), ['kommun:1280:1:2', 'kommun:1280:1:5']);
    sparaKommunplaner(db, [rad('kommun:1280:1:2', 0.01), rad('kommun:1280:1:3', 0.02)], '1280');
    sparaKommunplaner(db, [rad('kommun:1280:1:3', 0.02)], '1280');
    assert.deepEqual(db.prepare("SELECT id, status FROM plan WHERE kalla = 'kommun' ORDER BY id").all().map((r) => [r.id, r.status]),
      [['kommun:1280:1:2', 'arkiverad'], ['kommun:1280:1:3', 'laga kraft']]);
    assert.throws(() => sparaKommunplaner(db, [rad('kommun:1280:1:4', 0)], '0126'), /kommun stämmer inte/);
  } finally { db.close(); }
});

test('hämtning från ArcGIS: avkortat svar stoppar importen', async () => {
  const ring = [[13, 55.6], [13, 55.61], [13.01, 55.61], [13.01, 55.6], [13, 55.6]];
  await assert.rejects(hamtaKommunplaner('1280', async (url) => url.includes('returnIdsOnly')
    ? Response.json({ objectIds: [1, 2] })
    : Response.json({ exceededTransferLimit: true, features: [{ attributes: { OBJECTID: 1 }, geometry: { rings: [ring] } }] })), /ofullständigt svar/);
});
