import { setTimeout } from 'node:timers/promises';
import { geomBbox, withTransaction } from './db.mjs';
import { ROOT } from './db.mjs';
import { mkdirSync, existsSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { markeraPlanHamtning } from './uppdateringsmeta.mjs';

export const NGP_URL = 'https://api.lantmateriet.se/distribution/geodatakatalog/sokning/v1/detaljplan/v2/';
const TYP = { detaljplan: 'DP', stadsplan: 'SPL', byggnadsplan: 'BPL', avstyckningsplan: 'APL' };

function sparaPdf(bytes) {
  const name = `${createHash('sha256').update(bytes).digest('hex')}.pdf`;
  const dir = process.env.NGP_DOKUMENT_DIR || join(ROOT, 'public', 'plandokument');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, name);
  if (!existsSync(file)) writeFileSync(file, bytes, { flag: 'wx' });
  chmodSync(file, 0o644);
  return `/plandokument/${name}`;
}

const ASSET = 'https://api.lantmateriet.se/distribution/geodatakatalog/nedladdning/v1/asset/';
const DOKUMENT_ROLLER = ['beslutshandling', 'planbeskrivning'];
// Länken Horos visar för ett NGP-dokument som inte har hämtats i förväg; servern hämtar det vid första klicket.
export const vidBehovUrl = (href) => {
  const id = href?.startsWith(ASSET) && href.slice(ASSET.length);
  return /^[0-9a-f-]{36}$/.test(id) ? `/plandokument/ngp/${id}.pdf` : null;
};

// Högst `samtidigt` körningar åt gången och högst `ko` som väntar; fler ger fel med `full: true`.
// En plats som blir ledig lämnas direkt till nästa i kön.
export function begransare(samtidigt, ko) {
  let aktiva = 0;
  const vantar = [];
  return async (fn) => {
    if (aktiva < samtidigt) aktiva++;
    else if (vantar.length >= ko) throw Object.assign(new Error('för många väntande'), { full: true });
    else await new Promise((resolve) => vantar.push(resolve));
    try { return await fn(); }
    finally { const nasta = vantar.shift(); if (nasta) nasta(); else aktiva--; }
  };
}

// Ett dokument: { bytes } när Lantmäteriet lämnar PDF:en själv (bakom inloggning), annars { url } till en publik adress.
export async function hamtaDokument(href, user, password, request = fetch) {
  const url = new URL(href);
  if (url.origin !== 'https://api.lantmateriet.se' || !url.pathname.startsWith('/distribution/geodatakatalog/nedladdning/v1/asset/')) {
    throw new Error('Oväntad dokumentreferens från NGP.');
  }
  const options = { redirect: 'manual', signal: AbortSignal.timeout(30_000),
    headers: { Authorization: `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}` } };
  const response = await request(url.href, options);
  const location = response.headers.get('location');
  if (response.body) await response.body.cancel();
  if (response.status !== 303 || !location) throw new Error(`NGP-dokument gav HTTP ${response.status}, förväntade en dokumentadress.`);
  const target = new URL(location);
  if (target.origin === url.origin && target.pathname.startsWith('/distribution/geodatakatalog/nedladdning/v1/data/detaljplan/')
    && !target.username && !target.password) {
    const pdf = await request(target.href, { ...options, signal: AbortSignal.timeout(60_000) });
    if (!pdf.ok) {
      if (pdf.body) await pdf.body.cancel();
      throw new Error(`Kunde inte hämta PDF från NGP (HTTP ${pdf.status}).`);
    }
    const parts = []; let size = 0;
    for await (const chunk of pdf.body) {
      size += chunk.length;
      if (size > 50 * 1024 * 1024) throw new Error('Plandokumentet är större än 50 MB.');
      parts.push(chunk);
    }
    const bytes = Buffer.concat(parts);
    if (bytes.subarray(0, 5).toString() !== '%PDF-') throw new Error('Dokumentet är inte en PDF.');
    return { bytes };
  }
  if (target.protocol !== 'https:' || target.username || target.password || target.hostname === 'api.lantmateriet.se') {
    throw new Error(`Dokumentadressen kan inte visas som en publik HTTPS-länk (${target.protocol} // ${target.hostname}).`);
  }
  return { url: target.href };
}

export async function hamtaPlanDokument(features, user, password, request = fetch, savePdf = sparaPdf) {
  for (const f of features.filter((x) => x.properties?.feature?.typ === 'detaljplan')) {
    for (const a of Object.values(f.assets ?? {})) {
      if (!a.roles?.some((r) => DOKUMENT_ROLLER.includes(r))) continue;
      await setTimeout(200);
      const svar = await hamtaDokument(a.href, user, password, request);
      a.publikUrl = svar.url ?? await savePdf(svar.bytes);
    }
  }
  return features;
}

// Samlingarnas id i NGP (kommunkoder och eventuellt andra).
export async function ngpKommuner(user, password, request = fetch) {
  const response = await request(new URL('collections', NGP_URL).href, {
    headers: { Authorization: `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`, Accept: 'application/json' },
    redirect: 'error', signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`NGP svarade med HTTP ${response.status} på samlingslistan.`);
  const ids = (await response.json()).collections?.map((c) => c.id);
  if (!Array.isArray(ids)) throw new Error('NGP gav ett oväntat svar utan samlingar.');
  return ids;
}

export async function hamtaNgp(kommun, user, password, request = fetch, query) {
  if (!/^\d{4}$/.test(kommun)) throw new Error('Ange en fyrsiffrig kommunkod med --kommun.');
  const url = new URL('search', NGP_URL);
  let method = 'POST';
  let body = { collections: [kommun], limit: 100, ...(query && { query }) };
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
  if (!g || !['Polygon', 'MultiPolygon'].includes(g.type)) throw new Error(`NGP-objekt ${feature.id ?? p.objektidentitet} har geometri ${g?.type ?? 'saknas'}, förväntade Polygon eller MultiPolygon.`);
  const rings = g.type === 'Polygon' ? g.coordinates : g.coordinates?.flat();
  if (!Array.isArray(rings) || !rings.length || rings.some((ring) => !Array.isArray(ring) || ring.length < 4
    || ring.some((pt) => !Array.isArray(pt) || !Number.isFinite(pt[0]) || !Number.isFinite(pt[1])
      || Math.abs(pt[0]) > 180 || Math.abs(pt[1]) > 90)
    || ring[0][0] !== ring.at(-1)[0] || ring[0][1] !== ring.at(-1)[1])) throw new Error('NGP-geometrin är inte en giltig polygon i WGS84.');
  return { id: `ngp:${kommun}:${p.objektidentitet}`, typ: TYP[p.typ], planid: p.beteckning ?? null,
    namn: p.namn ?? null, datum: p.datumLagakraft ?? null, kommun, geojson: JSON.stringify(g),
    ...geomBbox(g), status: p.status, dokument: ngpDokument(feature) };
}

function ngpDokument(feature) {
  const lankar = Object.values(feature.assets ?? {}).filter((a) => a.roles?.some((r) => DOKUMENT_ROLLER.includes(r)))
    .map((a) => ({ titel: a.roles.includes('planbeskrivning') ? 'Planbeskrivning' : 'Plankarta', url: a.publikUrl ?? vidBehovUrl(a.href) }))
    .filter((d) => d.url);
  return lankar.length ? JSON.stringify(lankar) : null;
}

export function sparaNgp(db, planer, kommun) {
  const ins = db.prepare(`INSERT INTO plan (id, typ, planid, namn, datum, kommun, geojson, minx, miny, maxx, maxy, demo, kalla, status, bestammelser, dokument)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'ngp', ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET typ=excluded.typ, planid=excluded.planid, namn=excluded.namn,
      datum=excluded.datum, geojson=excluded.geojson, minx=excluded.minx, miny=excluded.miny,
      maxx=excluded.maxx, maxy=excluded.maxy, status=excluded.status, bestammelser=excluded.bestammelser,
      dokument=coalesce(excluded.dokument, plan.dokument)`);
  withTransaction(db, () => {
    markeraPlanHamtning(db, []);
    // Arkivera tidigare versioner som inte längre finns i kommunens fullständiga svar.
    db.prepare("UPDATE plan SET status = 'arkiverad' WHERE kalla = 'ngp' AND kommun = ?").run(kommun);
    for (const p of planer) {
      if (p.kommun !== kommun) throw new Error('Planens kommun stämmer inte med importen.');
      ins.run(p.id, p.typ, p.planid, p.namn, p.datum, p.kommun, p.geojson, p.minx, p.miny, p.maxx, p.maxy, p.status, p.bestammelser ?? null, p.dokument ?? null);
    }
    markeraPlanHamtning(db, [kommun]);
  });
}

export function ngpPlaner(features, kommun) {
  const plans = new Map(features.filter((f) => f.properties?.feature?.typ === 'detaljplan')
    .map((f) => [f.properties.detaljplan.objektidentitet, { ...ngpPlan(f, kommun), regler: [] }]));
  for (const f of features) {
    if (f.properties?.feature?.typ === 'detaljplan') continue;
    const b = f.properties?.planbestammelse, info = f.properties?.feature;
    const plan = plans.get(f.properties?.detaljplan?.objektidentitet);
    // NGP har ibland bestämmelser vars plan inte finns i svaret (Norrtälje 2026-10-21: 46 av 86 473). De kan inte visas.
    if (!plan) continue;
    if (typeof b?.bestammelseformulering !== 'string' || !b.bestammelseformulering.trim()) {
      throw new Error('NGP-bestämmelsen saknar bestämmelsetext. Ingen import gjordes.');
    }
    // Samma geometrikontroll som för planytan, innan något sparas.
    const g = f.geometry;
    if (['Polygon', 'MultiPolygon'].includes(g?.type)) {
      ngpPlan({ ...f, properties: { ...f.properties, feature: { typ: 'detaljplan' } } }, kommun);
    } else {
      const point = (p) => Array.isArray(p) && p.length >= 2 && p.every(Number.isFinite)
        && Math.abs(p[0]) <= 180 && Math.abs(p[1]) <= 90;
      const line = (l) => Array.isArray(l) && l.length >= 2 && l.every(point);
      const valid = g?.type === 'Point' ? point(g.coordinates)
        : g?.type === 'LineString' ? line(g.coordinates)
        : g?.type === 'MultiPoint' ? Array.isArray(g.coordinates) && g.coordinates.length && g.coordinates.every(point)
        : g?.type === 'MultiLineString' ? Array.isArray(g.coordinates) && g.coordinates.length && g.coordinates.every(line) : false;
      if (!valid) throw new Error(`Ogiltig bestämmelsegeometri för NGP-objekt ${f.id}.`);
    }
    const v = b.bestammelsevarde;
    if (v && (!Number.isFinite(v.variabelvarde) || (v.enhet != null && typeof v.enhet !== 'string')
      || (v.vardetyp != null && typeof v.vardetyp !== 'string'))) throw new Error('Ogiltigt bestämmelsevärde från NGP.');
    plan.regler.push({ typ: info.typ, etikett: info.etikett ?? '', text: b.bestammelseformulering,
      varde: v ? { tal: v.variabelvarde, typ: v.vardetyp ?? '', enhet: v.enhet ?? '' } : null, geometry: f.geometry });
  }
  return [...plans.values()].map(({ regler, ...p }) => ({ ...p, bestammelser: JSON.stringify(regler) }));
}
