// Plangränser från kommunernas egna, öppet tillgängliga karttjänster (ArcGIS REST och WFS), för kommuner där
// NGP saknar de äldre planerna. Användarens beslut 2026-10-21: används utan särskilt tillstånd, och en kommun som
// invänder tas bort (ta bort posten här och kör importen för kommunen). Tjänster vars plandata uttryckligen är
// kopierad från Lantmäteriets Fastighetskarta tas inte med (Mörbylånga), eftersom det är Lantmäteriets villkor som gäller. Vellinge lämnar inte ut geometrin i sin tjänst.
import { setTimeout } from 'node:timers/promises';
import { geomBbox, withTransaction } from './db.mjs';

const UA = { 'user-agent': 'horos/0.1 (ideell fastighetskarta; kontakt@horos.se)' };

// Bara fält som uttryckligen är laga kraft-datum blir datum (inte antagande- eller beslutsdatum).
// Planmosaik (Boverkets planmodell i ArcGIS): PLANSTATUS 6 = laga kraft.
const PLANMOSAIK = { planid: ['DocumentName', 'RegistrationNumber'], namn: 'Name', datum: 'LegallyBindingDate',
  hoppa: (p) => p.PLANSTATUS !== 6, dok: { Plandokument: 'DocumentLinks' } };

export const KALLOR = {
  '0126': { wfs: 'https://gd-huddinge.sokigohosting.com/public-maps/Oppnadata/MBF?token=9a11171d115c4a3c841c84f1dba068ef', lager: ['qgs:dp_plan'],
    planid: 'dp_plannummer', namn: 'dp_plannamn', datum: 'dp_laga_kraft_datum', typ: 'dp_plantyp', hoppa: (p) => p.dp_upphavd, dok: { Planhandlingar: 'dp_planhandlingar' } },
  '0163': { arcgis: 'https://geodata.sollentuna.se/arcgis/rest/services/Planmosaik/MapServer', lager: [7], ...PLANMOSAIK },
  '0183': { arcgis: 'https://gis.sundbyberg.se/arcgis/rest/services/Gallande_detaljplaner2/FeatureServer', lager: [1],
    planid: 'PLANNR', datum: 'LAGA_KRAFT', hoppa: (p) => p.PLANSKEDE && p.PLANSKEDE !== 'Laga kraft', dok: { Plankarta: 'LANK' } },
  '0428': { arcgis: 'https://karta.vingaker.se/server/rest/services/Samhällsbyggnad/Detaljplaner_och_Pågående_detaljplaner/FeatureServer', lager: [1],
    planid: 'Planbet', namn: 'Plannr', dok: { Plankarta: 'Länk' } },
  '0560': { wfs: 'https://karta.tranas.se/geoserver/wfs', lager: ['boxholm_kommunkarta:karta_detaljplaner-gallande'],
    namn: 'namn', typ: 'beskr', planid: (p) => p.link?.match(/^akt_(.+?)(\.VOL\d+)?\.pdf$/i)?.[1] },
  '0562': { arcgis: 'https://ext-gisapp.finspang.se/arcgis/rest/services/Externakartan/Detaljplaner/MapServer', lager: [0],
    planid: 'PLANBET', namn: 'PLNAMN', datum: 'LDAT', typ: 'PLANTYP', dok: { Plankarta: 'Länk' } },
  '0586': { arcgis: 'https://gis.mjolby.se/arcgis/rest/services/Extern/Extern_Detaljplaner/MapServer', lager: [2],
    planid: ['ID_LM', 'BNKL'], namn: 'RUBRIK', typ: 'PLANTYP', dok: { Plankarta: 'Lank_plankarta', Planhandlingar: 'Lank_dokument' } },
  '0687': { wfs: 'https://karta.tranas.se/geoserver/wfs', lager: ['tranas_kommunkarta:karta_detaljplaner-gallande'],
    namn: 'namn', typ: 'beskr', planid: (p) => p.link?.match(/^akt_(.+?)(\.VOL\d+)?\.pdf$/i)?.[1] },
  '0767': { wfs: 'https://karta.markaryd.se/api/v2/proxy/geoserver/geoserver/ws-Detaljplan/wfs',
    lager: ['ws-Detaljplan:Detaljplaner', 'ws-Detaljplan:Stadsplaner', 'ws-Detaljplan:Byggnadsplaner'],
    planid: 'BESKRIV', namn: 'PLANNAMN', typ: (_p, lager) => lager },
  '0880': { arcgis: 'https://karta.kalmar.se/ags/rest/services/sde_kalmar/DetplanOmrbest/MapServer', lager: [0], planid: 'AKT' },
  '1230': { arcgis: 'https://kartportal.se/gis/rest/services/stp_pub_detaljplanering/MapServer', lager: [10],
    planid: 'PLANBET', namn: 'Planrubrik', datum: 'LDAT', typ: 'PLANTYP', dok: { Plankarta: 'URL_Plankarta', Planbeskrivning: 'URL_Beskrivning' } },
  '1231': { arcgis: 'https://services3.arcgis.com/pbJHvUPC8XgHoBKj/arcgis/rest/services/Detaljplaner_Gällande_Pågående_etikett/FeatureServer', lager: [1],
    planid: 'NAMN', namn: 'NUMMER', dok: { Plankarta: 'Link_2' } },
  '1256': { arcgis: 'https://kartportal.unikom.se/arcgis/rest/services/og_planering/Planering_extern/MapServer', lager: [1, 2],
    planid: 'dp_aktnummer', namn: 'dp_plannamn', datum: 'dp_laga_kraft_datum', typ: 'dp_plantyp', hoppa: (p) => p.dp_upphavd,
    dok: { Planhandlingar: 'dp_planhandlingar' } },
  '1263': { arcgis: 'https://services-eu1.arcgis.com/EHBdsHl0kxteIlk0/arcgis/rest/services/Gällande detaljplaner/FeatureServer', lager: [0],
    planid: 'DP_NR_LMV', namn: 'DP_NR_K', dok: { Plankarta: 'HOTLINK', Planbeskrivning: 'Planbeskrivning' } },
  '1264': { arcgis: 'https://services-eu1.arcgis.com/2D8y3RBcrHZsGMzp/arcgis/rest/services/Skurupkartan/FeatureServer', lager: [4],
    planid: 'beskriv', namn: 'plannamn', typ: 'plantyp', dok: { Plankarta: 'plankarta', Planbeskrivning: 'planbest' } },
  '1265': { arcgis: 'https://gis.sjobo.se/arcgis/rest/services/Extern/Byggaboochmiljo/MapServer', lager: [878], planid: 'Lantm_Län', namn: 'Namn' },
  '1270': { wfs: 'https://kartor.tomelilla.se/geoserver/geostore/ows', lager: ['geostore:detaljplaner'],
    planid: 'planbet', namn: 'plnamn', datum: 'laga_kraft', typ: 'plantyp',
    dok: { Plankarta: 'plankarta_mycarta', Planbeskrivning: 'planbeskrivning_mycarta' } },
  '1280': { arcgis: 'https://gis.malmo.se/arcgis/rest/services/SEPlan/Gallande_planer/MapServer', lager: [1],
    planid: 'LMAKT', namn: 'PLANNAMN', datum: 'FIX_LAGAKR', typ: 'PLAN_' },   // länkarna går till interna/testservrar
  '1281': { arcgis: 'https://webbgis.lund.se/arcgis/rest/services/SBK/Lund_GallandePlaner/MapServer', lager: [213],
    planid: 'EXTID', namn: 'NAMN', datum: 'LAGAKRAFT_DAT', typ: 'DEP', dok: { Planhandlingar: 'URL' } },
  '1463': { arcgis: 'https://kartor.mark.se/arcgis/rest/services/Samhallsplanering/Gallande_planer/MapServer', lager: [1] },
  '1466': { arcgis: 'https://gisportal.hervar.se/arcgis/rest/services/Samhällsplanering/Detaljplaner_Herrljunga/FeatureServer', lager: [193], ...PLANMOSAIK },
  '1470': { arcgis: 'https://geoportal.vara.se/arcgis/rest/services/Webblager/Detaljplaner/MapServer', lager: [5], ...PLANMOSAIK },
  '1472': { arcgis: 'https://enterprise.tibro.se/arcgis/rest/services/Detaljplan/MapServer', lager: [1],
    planid: 'Detaljplan', namn: 'Namn_1', datum: 'Laga_Kraft', dok: { Plankarta: 'Länk_2' } },
  '1490': { arcgis: 'https://kartportalen.boras.se/server/rest/services/Planöversikt/FeatureServer', lager: [6],
    planid: 'aktbet', namn: 'planbet', datum: 'lagakraft', dok: { Planhandlingar: 'dokument_kartportalen' } },
  '1491': { arcgis: 'https://gisportal.ulricehamn.se/arcgis/rest/services/Extern_webb/Detaljplaner_externt/FeatureServer', lager: [6], ...PLANMOSAIK },
  '1492': { arcgis: 'https://services-eu1.arcgis.com/77uvMqUXzusefKzi/arcgis/rest/services/Åmåls_kommun___Gällande_detaljplaner_WFL1/FeatureServer', lager: [1],
    planid: 'BESKRIV', namn: 'PLANNAMN', typ: 'PLANTYP', dok: { Plankarta: 'Plankarta', Planbeskrivning: 'Planbeskrivning' } },
  '2081': { arcgis: 'https://gisweb.borlange.se/arcgis/rest/services/Public/Detaljplaner/MapServer', lager: [0],
    planid: 'PLANBET', namn: 'PLNAMN', datum: 'LDAT', typ: 'PLANTYP' },   // länkarna går till en intern server
  '2082': { arcgis: 'https://services-eu1.arcgis.com/Edg0lenBBoWlakRf/arcgis/rest/services/Detaljplaner_Ytor/FeatureServer', lager: [0],
    planid: 'PLANBETECK', namn: 'PLANNAMN', typ: 'PLANFORKOR', dok: { Plankarta: 'LANKKARTA', Planbeskrivning: 'LANKTEXT' } },
  '2510': { arcgis: 'https://geoportal.jokkmokk.se/arcgis/rest/services/Detaljplaner/Detaljplaner_Laga_kraft_201022/MapServer', lager: [5], ...PLANMOSAIK },
};

// ÅÅÅÅ-MM-DD, eller bara året när källan bara har det. Epok-millisekunder, ÅÅÅÅMMDD och text med ett datum i.
export function datum(v) {
  if (v == null || v === '') return null;
  let s;
  if (typeof v === 'number') {
    if (Number.isInteger(v) && v >= 18000101 && v <= 21001231) s = String(v);
    else if (Number.isInteger(v) && v >= 1800 && v <= 2100) return String(v);
    else s = new Date(v).toISOString().slice(0, 10);   // ArcGIS: datumfält som midnatt UTC i ms
  } else s = String(v);
  const m = s.match(/(1[89]\d\d|20\d\d)-?([01]\d)-?([0-3]\d)/) ?? s.match(/^\s*(1[89]\d\d|20\d\d)\s*$/);
  return !m ? null : m[2] ? `${m[1]}-${m[2]}-${m[3]}` : m[1];
}

// Klartext först ("Byggnadsplan" innehåller "spl"), sedan koder som PLANSPL, DP4000 och "BPL - Antagen 1965".
const TYPER = [[/ändring av områdesbest/iu, 'ÄOB'], [/områdesbest/iu, 'OB'], [/ändring av d/iu, 'ÄDP'], [/byggnadsplan/iu, 'BPL'],
  [/stadsplan/iu, 'SPL'], [/avstyckningsplan/iu, 'APL'], [/tomtindelning/iu, 'TI'], [/fastighetsplan/iu, 'FP'],
  [/generalplan/iu, 'GPL'], [/detaljplan/iu, 'DP']];
export function plantyp(v) {
  const s = String(v ?? '');
  return TYPER.find(([re]) => re.test(s))?.[1]
    ?? s.match(/(?:^|PLAN|[^A-ZÅÄÖ])(ÄOB|OB|ÄDP|DP|SPL|BPL|APL|TI|FP|GPL)(?![A-ZÅÄÖ])/iu)?.[1].toUpperCase() ?? 'DP';
}

const falt = (p, f, lager) => typeof f === 'function' ? f(p, lager)
  : Array.isArray(f) ? f.map((k) => p[k]).find((x) => x != null && String(x).trim() !== '') : f ? p[f] : null;
const text = (v) => v == null || String(v).trim() === '' ? null : String(v).trim();
// Kommunernas länkar har ibland mellanslag och å/ä/ö okodade, ibland redan kodade.
const kodaUrl = (u) => { try { return encodeURI(decodeURI(u)); } catch { return encodeURI(u); } };

// Esri-polygon (ytterringar medurs, hål moturs) till GeoJSON.
export function esriTillGeojson(g) {
  if (!Array.isArray(g?.rings)) return null;
  const polys = [];
  for (const ring of g.rings) {
    const sum = ring.reduce((s, [x, y], i) => { const [x2, y2] = ring[(i + 1) % ring.length]; return s + (x2 - x) * (y2 + y); }, 0);
    if (sum >= 0 || !polys.length) polys.push([ring]); else polys.at(-1).push(ring);
  }
  return polys.length === 1 ? { type: 'Polygon', coordinates: polys[0] } : { type: 'MultiPolygon', coordinates: polys };
}

// 2D, lon/lat i Sverige (byter axlar om tjänsten svarade lat/lon), slutna ringar. Annars null.
export function rensaGeometri(g) {
  if (!g || !['Polygon', 'MultiPolygon'].includes(g.type)) return null;
  const polys = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
  const forsta = polys?.[0]?.[0]?.[0];
  if (!Array.isArray(forsta)) return null;
  const byt = forsta[0] > 50;
  const ut = polys.map((poly) => poly.map((ring) => ring.map((pt) => byt ? [pt[1], pt[0]] : [pt[0], pt[1]])));
  const ok = ut.every((poly) => poly.length && poly.every((ring) => ring.length >= 4
    && ring.every(([x, y]) => Number.isFinite(x) && Number.isFinite(y) && x > 10 && x < 25 && y > 55 && y < 70)
    && ring[0][0] === ring.at(-1)[0] && ring[0][1] === ring.at(-1)[1]));
  if (!ok) return null;
  return ut.length === 1 ? { type: 'Polygon', coordinates: ut[0] } : { type: 'MultiPolygon', coordinates: ut };
}

async function hamtaJson(url, request) {
  const r = await request(url, { headers: UA, signal: AbortSignal.timeout(60_000) });
  if (!r.ok) throw new Error(`HTTP ${r.status} från ${new URL(url).hostname}`);
  return r.json();
}

async function hamtaArcgis(bas, lager, request) {
  const url = `${encodeURI(bas)}/${lager}/query`;
  const ids = await hamtaJson(`${url}?where=1%3D1&returnIdsOnly=true&f=json`, request);
  if (ids.error || !Array.isArray(ids.objectIds)) throw new Error(`ArcGIS-lager ${lager}: ${ids.error?.message ?? 'inga objekt-id'}`);
  const ut = [];
  for (let i = 0; i < ids.objectIds.length; i += 200) {
    await setTimeout(200);
    const d = await hamtaJson(`${url}?objectIds=${ids.objectIds.slice(i, i + 200).join(',')}&outFields=*&outSR=4326&f=json`, request);
    if (d.error || !Array.isArray(d.features)) throw new Error(`ArcGIS-lager ${lager}: ${d.error?.message ?? 'ogiltigt svar'}`);
    // Ett avkortat svar får inte bli en komplett import (saknade planer skulle arkiveras).
    if (d.exceededTransferLimit || d.features.length !== ids.objectIds.slice(i, i + 200).length) {
      throw new Error(`ArcGIS-lager ${lager}: ofullständigt svar (${d.features.length} av ${ids.objectIds.slice(i, i + 200).length})`);
    }
    // Fältnamnet står ofta bara i id-svaret (Malmö: OBJECTID_1 bredvid ett annat OBJECTID).
    const oid = ids.objectIdFieldName ?? d.objectIdFieldName ?? d.fields?.find((f) => f.type === 'esriFieldTypeOID')?.name ?? 'OBJECTID';
    ut.push(...d.features.map((f) => ({ id: f.attributes[oid], p: f.attributes, g: esriTillGeojson(f.geometry) })));
  }
  return ut;
}

async function hamtaWfs(bas, lager, request) {
  const url = new URL(bas);
  for (const [k, v] of Object.entries({ service: 'WFS', version: '2.0.0', request: 'GetFeature', typeNames: lager,
    outputFormat: 'application/json', srsName: 'EPSG:4326' })) url.searchParams.set(k, v);
  const d = await hamtaJson(url.href, request);
  if (d.type !== 'FeatureCollection' || !Array.isArray(d.features)) throw new Error(`WFS ${lager}: ogiltigt svar`);
  if (Number.isFinite(d.numberMatched) && d.numberMatched > d.features.length) throw new Error(`WFS ${lager}: bara ${d.features.length} av ${d.numberMatched} objekt`);
  return d.features.map((f, i) => ({ id: f.id ?? i, p: f.properties ?? {}, g: f.geometry }));
}

export async function hamtaKommunplaner(kod, request = fetch) {
  const k = KALLOR[kod];
  if (!k) throw new Error(`Ingen karttjänst inlagd för ${kod}.`);
  const rader = [], sedda = new Set();
  let utanGeometri = 0;
  for (const lager of k.lager) {
    const objekt = k.arcgis ? await hamtaArcgis(k.arcgis, lager, request) : await hamtaWfs(k.wfs, lager, request);
    for (const { id, p, g } of objekt) {
      // Samma id två gånger skulle skriva över planer; då stoppas kommunen hellre.
      if (id == null || sedda.has(`${lager}:${id}`)) throw new Error(`lager ${lager}: saknat eller upprepat objekt-id (${id})`);
      sedda.add(`${lager}:${id}`);
      if (k.hoppa?.(p)) continue;
      const geom = rensaGeometri(g);
      if (!geom) { utanGeometri++; continue; }
      const dok = Object.entries(k.dok ?? {}).flatMap(([titel, f]) => String(p[f] ?? '').split(/[\r\n]+/).map((u) => u.trim())
        .filter((u) => /^https:\/\/[^"<>\\]+$/.test(u)).map((u) => ({ titel, url: kodaUrl(u) })));
      rader.push({ id: `kommun:${kod}:${lager}:${id}`, typ: plantyp(falt(p, k.typ, lager) ?? lager), planid: text(falt(p, k.planid, lager)),
        namn: text(falt(p, k.namn, lager)), datum: datum(falt(p, k.datum, lager)), kommun: kod, geojson: JSON.stringify(geom),
        ...geomBbox(geom), dokument: dok.length ? JSON.stringify([...new Map(dok.map((d) => [d.url, d])).values()].slice(0, 4)) : null });
    }
  }
  return { rader, utanGeometri };
}

// Planer som NGP redan har med laga kraft (samma kommun, nästan samma utbredning, ~20 m) tas inte med två gånger.
// Ett förslag i NGP ersätter inte den gällande planen.
export function utanNgpDubbletter(db, rader, kod) {
  const ngp = db.prepare(`SELECT minx, miny, maxx, maxy FROM plan WHERE kalla = 'ngp' AND kommun = ? AND status = 'laga kraft'`).all(kod);
  const nara = (a, b) => Math.abs(a - b) < 0.0003;
  return rader.filter((r) => !ngp.some((n) => nara(n.minx, r.minx) && nara(n.miny, r.miny) && nara(n.maxx, r.maxx) && nara(n.maxy, r.maxy)));
}

// Tidigare rader för kommunen arkiveras (raderas inte); de som finns i det nya svaret återaktiveras.
export function sparaKommunplaner(db, rader, kod) {
  const ins = db.prepare(`INSERT INTO plan (id, typ, planid, namn, datum, kommun, geojson, minx, miny, maxx, maxy, demo, kalla, status, dokument)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'kommun', 'laga kraft', ?)
    ON CONFLICT(id) DO UPDATE SET typ=excluded.typ, planid=excluded.planid, namn=excluded.namn, datum=excluded.datum,
      geojson=excluded.geojson, minx=excluded.minx, miny=excluded.miny, maxx=excluded.maxx, maxy=excluded.maxy,
      status='laga kraft', dokument=excluded.dokument`);
  withTransaction(db, () => {
    db.prepare("UPDATE plan SET status = 'arkiverad' WHERE kalla = 'kommun' AND kommun = ?").run(kod);
    for (const r of rader) {
      if (r.kommun !== kod) throw new Error('Planens kommun stämmer inte med importen.');
      ins.run(r.id, r.typ, r.planid, r.namn, r.datum, r.kommun, r.geojson, r.minx, r.miny, r.maxx, r.maxy, r.dokument);
    }
  });
}
