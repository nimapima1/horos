import { setTimeout } from 'node:timers/promises';
import { geomBbox, withTransaction } from './db.mjs';

export const NGP_URL = 'https://api.lantmateriet.se/distribution/geodatakatalog/sokning/v1/detaljplan/v2/';
const TYP = { detaljplan: 'DP', stadsplan: 'SPL', byggnadsplan: 'BPL', avstyckningsplan: 'APL' };

export async function hamtaNgp(kommun, user, password, request = fetch) {
  if (!/^\d{4}$/.test(kommun)) throw new Error('Ange en fyrsiffrig kommunkod med --kommun.');
  const url = new URL('search', NGP_URL);
  let method = 'POST';
  let body = { collections: [kommun], limit: 100, query: { 'feature.typ': { eq: 'detaljplan' } } };
  let next = url.href;
  const pages = new Set(), features = [];
  while (next) {
    const pageUrl = new URL(next, NGP_URL);
    pageUrl.searchParams.set('crs', 'http://www.opengis.net/def/crs/OGC/1.3/CRS84');
    if (pageUrl.origin !== new URL(NGP_URL).origin || !pageUrl.pathname.startsWith(new URL(NGP_URL).pathname)) {
      throw new Error('NGP gav en sidlänk utanför söktjänsten.');
    }
    const pageKey = `${method} ${pageUrl.href} ${JSON.stringify(body)}`;
    if (pages.has(pageKey)) throw new Error('NGP upprepade samma sida. Importen avbröts.');
    pages.add(pageKey);
    if (pages.size > 1) await setTimeout(200);
    const response = await request(pageUrl.href, {
      method, body: method === 'POST' ? JSON.stringify(body) : undefined,
      headers: { Authorization: `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`, Accept: 'application/geo+json', 'Content-Type': 'application/json' },
      redirect: 'error', signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 1500);
      throw new Error(`NGP svarade med HTTP ${response.status}. Ingen import gjordes.\n${detail}`);
    }
    const data = await response.json();
    if (data.type !== 'FeatureCollection' || !Array.isArray(data.features)) throw new Error('NGP gav ett ogiltigt svar.');
    features.push(...data.features);
    const link = data.links?.find((l) => l.rel === 'next');
    if (link && link.method && !['GET', 'POST'].includes(link.method)) throw new Error('NGP gav en sidlänk med en oväntad metod.');
    if (link) {
      method = link.method ?? 'GET';
      body = method === 'POST' ? (link.merge ? { ...body, ...link.body } : link.body ?? body) : undefined;
    }
    next = link ? new URL(link.href, pageUrl).href : null;
  }
  return features;
}

export function ngpPlan(feature, kommun) {
  const p = feature.properties?.detaljplan;
  if (feature.properties?.feature?.typ !== 'detaljplan') throw new Error('NGP-svaret innehåller annat än planer.');
  if (!p?.objektidentitet || !TYP[p.typ] || typeof p.status !== 'string') throw new Error('NGP-planen saknar identitet, plantyp eller status.');
  const g = feature.geometry;
  if (!g || !['Polygon', 'MultiPolygon'].includes(g.type)) throw new Error('NGP-planen saknar polygongeometri.');
  const rings = g.type === 'Polygon' ? g.coordinates : g.coordinates?.flat();
  if (!Array.isArray(rings) || !rings.length || rings.some((ring) => !Array.isArray(ring) || ring.length < 4
    || ring.some((pt) => !Array.isArray(pt) || !Number.isFinite(pt[0]) || !Number.isFinite(pt[1])
      || Math.abs(pt[0]) > 180 || Math.abs(pt[1]) > 90)
    || ring[0][0] !== ring.at(-1)[0] || ring[0][1] !== ring.at(-1)[1])) throw new Error('NGP-geometrin är inte en giltig polygon i WGS84.');
  return { id: `ngp:${kommun}:${p.objektidentitet}`, typ: TYP[p.typ], planid: p.beteckning ?? null,
    namn: p.namn ?? null, datum: p.datumLagakraft ?? null, kommun, geojson: JSON.stringify(g),
    ...geomBbox(g), status: p.status };
}

export function sparaNgp(db, planer, kommun) {
  const ins = db.prepare(`INSERT INTO plan (id, typ, planid, namn, datum, kommun, geojson, minx, miny, maxx, maxy, demo, kalla, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'ngp', ?)
    ON CONFLICT(id) DO UPDATE SET typ=excluded.typ, planid=excluded.planid, namn=excluded.namn,
      datum=excluded.datum, geojson=excluded.geojson, minx=excluded.minx, miny=excluded.miny,
      maxx=excluded.maxx, maxy=excluded.maxy, status=excluded.status`);
  withTransaction(db, () => {
    // Arkivera tidigare versioner som inte längre finns i kommunens fullständiga svar.
    db.prepare("UPDATE plan SET status = 'arkiverad' WHERE kalla = 'ngp' AND kommun = ?").run(kommun);
    for (const p of planer) {
      if (p.kommun !== kommun) throw new Error('Planens kommun stämmer inte med importen.');
      ins.run(p.id, p.typ, p.planid, p.namn, p.datum, p.kommun, p.geojson, p.minx, p.miny, p.maxx, p.maxy, p.status);
    }
  });
}
