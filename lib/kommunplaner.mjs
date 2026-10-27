// Plangränser från kommunernas egna, öppet tillgängliga karttjänster (ArcGIS REST och WFS), för kommuner där
// NGP saknar de äldre planerna. Användarens beslut 2026-10-21: används utan särskilt tillstånd, och en kommun som
// invänder tas bort (ta bort posten här och kör importen för kommunen). Tjänster vars plandata uttryckligen är
// kopierad från Lantmäteriets Fastighetskarta tas inte med (Mörbylånga, tills kommunen själv skickade sitt uttag), eftersom det är Lantmäteriets villkor som gäller. Vellinge lämnar inte ut geometrin i sin tjänst.
import { setTimeout } from 'node:timers/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ROOT, geomBbox, withTransaction } from './db.mjs';
import { SWEREF_LOKAL, mapCoords, parseGpkgGeometry, sweref99ToWgs84 } from './geo.mjs';
import { lasShape } from './shp.mjs';

const UA = { 'user-agent': 'horos/0.1 (ideell fastighetskarta; kontakt@horos.se)' };

// Bara fält som uttryckligen är laga kraft-datum blir datum (inte antagande- eller beslutsdatum).
// Planmosaik (Boverkets planmodell i ArcGIS): PLANSTATUS 6 = laga kraft.
const PLANMOSAIK = { planid: ['DocumentName', 'RegistrationNumber'], namn: 'Name', datum: 'LegallyBindingDate',
  hoppa: (p) => p.PLANSTATUS != null && p.PLANSTATUS !== 6, dok: { Plandokument: 'DocumentLinks' } };

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
  '0586': { kontrollera: true, arcgis: 'https://gis.mjolby.se/arcgis/rest/services/Extern/Extern_Detaljplaner/MapServer', lager: [2],
    planid: ['ID_LM', 'BNKL'], namn: 'RUBRIK', typ: 'PLANTYP', dok: { Plankarta: 'Lank_plankarta', Planhandlingar: 'Lank_dokument' } },
  '0687': { wfs: 'https://karta.tranas.se/geoserver/wfs', lager: ['tranas_kommunkarta:karta_detaljplaner-gallande'],
    namn: 'namn', typ: 'beskr', planid: (p) => p.link?.match(/^akt_(.+?)(\.VOL\d+)?\.pdf$/i)?.[1] },
  '0767': { wfs: 'https://karta.markaryd.se/api/v2/proxy/geoserver/geoserver/ws-Detaljplan/wfs',
    lager: ['ws-Detaljplan:Detaljplaner', 'ws-Detaljplan:Stadsplaner', 'ws-Detaljplan:Byggnadsplaner'],
    planid: 'BESKRIV', namn: 'PLANNAMN', typ: (_p, lager) => lager },
  '0880': { sida: 'https://kalmar.se/bygga-bo-och-miljo/samhallsutveckling/planering/gallande-detaljplaner.html', arcgis: 'https://karta.kalmar.se/ags/rest/services/sde_kalmar/DetplanOmrbest/MapServer', lager: [0], planid: 'AKT' },
  '1230': { arcgis: 'https://kartportal.se/gis/rest/services/stp_pub_detaljplanering/MapServer', lager: [10],
    planid: 'PLANBET', namn: 'Planrubrik', datum: 'LDAT', typ: 'PLANTYP', dok: { Plankarta: 'URL_Plankarta', Planbeskrivning: 'URL_Beskrivning' } },
  '1231': { kontrollera: true, arcgis: 'https://services3.arcgis.com/pbJHvUPC8XgHoBKj/arcgis/rest/services/Detaljplaner_Gällande_Pågående_etikett/FeatureServer', lager: [1],
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
  '1280': { sida: 'https://malmo.se/detaljplaner', arcgis: 'https://gis.malmo.se/arcgis/rest/services/SEPlan/Gallande_planer/MapServer', lager: [1],
    planid: 'LMAKT', namn: 'PLANNAMN', datum: 'FIX_LAGAKR', typ: 'PLAN_',
    // Tjänstens länkar går till en intern server. Den publika planvisarens sökning ger planens PDF:er, eller inga.
    dokSok: async (p, request) => {
      const plan = p.PLAN_?.trim();
      if (!plan) return [];
      const urls = await hamtaJson(`https://geo.malmo.se/planvisaren-server/search?q=${encodeURIComponent(plan)}`, request);
      if (!Array.isArray(urls)) throw new Error('planvisaren: ogiltigt svar');
      return urls.filter((u) => u.startsWith('https://geo.malmo.se/planvisaren-server/pdf/')).map((url) => {
        const del = url.match(/_(\w+)\.pdf$/i)?.[1];
        return { titel: del === 'dok' ? 'Planbeskrivning' : /^\d+$/.test(del) ? `Plankarta del ${del}` : 'Plandokument', url };
      });
    } },
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
  // Detaljplan: "25-P84-65_B19841018_SPL" (akt, beslutsdatum, plantyp).
  '2510': { kontrollera: true, arcgis: 'https://geoportal.jokkmokk.se/arcgis/rest/services/Detaljplaner/Detaljplan_PDF/MapServer', lager: [0],
    planid: (p) => p.Detaljplan?.split(/_B_?\d/)[0], namn: 'Kvarter', typ: (p) => p.Detaljplan?.split('_').at(-1), dok: { Plankarta: 'Lank_PDF' } },
  // Tillagda 2026-10-21: kommuner med öppen tjänst men bara enstaka äldre planer i NGP. Inte med: Tingsryd och
  // Falköping (Lantmäteriets plandata), Gotland (bara bestämmelseytor), Jönköping (WFS:en borttagen), Ockelbo och
  // Hofors (VGS fil är Lantmäteriets registerkarta, td_drk_rk_plan_y).
  '0117': { arcgis: 'https://gisportal.osteraker.se/arcgis/rest/services/Detaljplaner/Detaljplaner_gällande/MapServer', lager: [0],
    planid: 'PLANNUMMER', namn: 'NAMN', datum: 'LAGAKRAFT' },
  '0162': { arcgis: 'https://kartportalen.danderyd.se/arcgis/rest/services/Sök_plan/MapServer', lager: [30],
    planid: 'LMAKT', namn: 'PLANNAMN', typ: 'PLANFK' },
  '0319': { kontrollera: true, arcgis: 'https://gis.gavle.se/server/rest/services/pbf_planering/planarkivet_gastrikland_f_d/MapServer', lager: [0], where: "KOMMUNKOD='0319'",
    planid: 'LMVAKT', namn: 'PLANNAMN', typ: 'OBJEKTTYP', dok: { Plankarta: 'SOKVAG_PDF_LOKAL' } },
  '0331': { arcgis: 'https://kartor.heby.se/arcgis/rest/services/Kommunkarta/Detaljplaner/MapServer', lager: [2],
    planid: 'PLANBET', namn: 'PLNAMN', datum: 'LDAT', typ: 'PLANTYP' },
  '0481': { arcgis: 'https://karta.oxelosund.se/arcgis/rest/services/Public/Detaljplaner_yta/MapServer', lager: [0], planid: 'name' },
  '0509': { wfs: 'https://karta.tranas.se/geoserver/wfs', lager: ['odeshogext:karta_detaljplaner-gallande'],
    namn: 'namn', typ: 'beskr', planid: (p) => p.link?.match(/^akt_(.+?)(\.VOL\d+)?\.pdf$/i)?.[1] },
  '0512': { wfs: 'https://karta.tranas.se/geoserver/wfs', lager: ['ydre_kommunkarta:karta_detaljplaner-gallande'],
    namn: 'namn', typ: 'beskr', planid: (p) => p.link?.match(/^akt_(.+?)(\.VOL\d+)?\.pdf$/i)?.[1] },
  '0561': { arcgis: 'https://services-eu1.arcgis.com/prMbcX0078KPzxQZ/arcgis/rest/services/Detaljplaner/FeatureServer', lager: [0], planid: 'BESKRIV' },
  '0580': { sida: 'https://www.linkoping.se/stadsplanering-och-trafik/detaljplanering', arcgis: 'https://kartor.linkoping.se/arcgis/rest/services/detaljplanekartan/detaljplanekartan_p/MapServer', lager: [0],
    planid: 'EXTID', namn: 'PLANNAMN', typ: 'DEP' },
  '0583': { arcgis: 'https://utility.arcgis.com/usrsvcs/servers/5e57cc208ce84edfadad188b3064f0af/rest/services/PUBLIC_SERVICES/Bygga_bo_miljo_1/MapServer', lager: [11],
    planid: 'ARKEN', namn: 'DPNR', typ: 'TYP', dok: { Plankarta: 'DOCLINK' } },
  '0584': { kontrollera: true, arcgis: 'https://gisportal.vadstena.se/arcgis/rest/services/Datalager/Bygga_och_bo/MapServer', lager: [6],
    planid: 'PLANBET', namn: 'PLNAMN', datum: 'LDAT', typ: 'PLANTYP', dok: { Plankarta: 'dokument' } },
  '0617': { kontrollera: true, arcgis: 'https://gisportal.gnosjo.se/arcgis/rest/services/Plan/Detaljplanoversikt/MapServer', lager: [0],
    planid: 'Name', namn: 'Descr', datum: 'Vunnit_l30', dok: { Plankarta: 'Filename' } },
  '0665': { arcgis: 'https://geodata.vaggeryd.se/arcgis/rest/services/Extern_karta/Extern_karta/MapServer', lager: [39],
    planid: 'PLANBET', namn: 'PLNAMN', datum: 'LDAT', typ: 'PLANTYP' },
  '0761': { arcgis: 'https://gis.lessebo.se/arcgis/rest/services/Detaljplankarta_Lessebo/MapServer', lager: [0],
    planid: 'Akt_nr', namn: 'Name', datum: 'LegallyBin', dok: { Plankarta: 'Plan_K', Planbeskrivning: 'Plan_B' } },
  '0764': { kontrollera: true, arcgis: 'https://argo.alvesta.se/arcgis/rest/services/Detaljplan_ytor/MapServer', lager: [0],
    planid: 'Plannr_L30', datum: 'Laga_kra29', dok: { Plankarta: 'Descr' } },
  '0765': { arcgis: 'https://geodata.almhult.se/server/rest/services/Geodataportalen/Detaljplaner/MapServer', lager: [360],
    planid: 'PLNAMN', typ: 'PLANTYP', hoppa: (p) => p.Planskede && p.Planskede !== 'Gällande', dok: { Plankarta: 'PLANDOKUMENT_LANK' } },
  '0780': { sida: 'https://www.vaxjo.se/sidor/trafik-och-stadsplanering/stadsplanering/detaljplan/gallande-detaljplaner.html', arcgis: 'https://gis1.vaxjo.se/arcgis/rest/services/webbkartor_hemsida/Blandade_lager/MapServer', lager: [15], planid: 'BETECKNING' },
  '0781': { sida: 'https://www.ljungby.se/trafik-och-samhallsplanering/samhallsplanering/oversiktsplan-och-detaljplaner/detaljplaner/gallande-detaljplaner', arcgis: 'https://giswa.ljungby.se/server/rest/services/Publicerade_webblager/Detaljplaner/FeatureServer', lager: [0],
    planid: 'PLANBET', namn: ['Namn', 'PLNAMN'], typ: 'PLANTYP' },
  '1260': { arcgis: 'https://gisportal.perstorp.se/arcgis/rest/services/Bjuv/Planytor_för_publicering_externa_webbkartan/MapServer', lager: [2],
    planid: 'planbet', namn: 'plnamn', datum: 'ldat', typ: 'plantyp' },
  '1261': { arcgis: 'https://kartportal.se/gis/rest/services/kav_pub_planering/MapServer', lager: [296],
    planid: 'PLANBET', namn: 'PLNAMN', typ: 'PLANTYP', dok: { Plankarta: 'URLPlankarta', Planbeskrivning: 'URLPlanbeskrivning' } },
  '1262': { arcgis: 'https://gis.lomma.se/arcgis/rest/services/extern_kommunkarta/bygga_bo/MapServer', lager: [2, 1],
    planid: 'PLANBET', namn: 'PLNAMN', datum: 'LDAT', typ: 'PLANTYP' },
  '1273': { arcgis: 'https://kartportal.unikom.se/arcgis/rest/services/osby_planering_detaljplan/Detaljplaner_externt/MapServer', lager: [0, 2, 3],
    planid: 'dp_aktnummer', namn: 'plannamn', typ: (p, lager) => p.dp_plantyp ?? { 2: 'OB', 3: 'ÄDP' }[lager] },
  '1283': { sida: 'https://helsingborg.se/trafik-och-stadsplanering/planering-och-utveckling/detaljplanering/gallande-detaljplaner/', geojson: 'https://oppnadata.helsingborg.se/sbf/regioner_och_stader/gallande_detaljplaneomraden/gallande_detaljplaneomraden.geojson',
    lager: ['fil'], planid: 'PlanID' },
  '1083': { arcgis: 'https://map.solvesborg.se/arcgis/rest/services/Detaljplaner_och_områdesbestämmelser/FeatureServer', lager: [0],
    planid: 'EXTERNID', namn: 'Arkivnum32', datum: 'Laga_kraft', typ: 'PLANTYP_1', dok: { Plankarta: 'Links_1' } },
  '1419': { arcgis: 'https://gis.tjorn.se/arcgis/rest/services/Fastighetsavd/planer20240318_extern_test/FeatureServer', lager: [1],
    planid: 'planbet', namn: 'plnamn', datum: 'ldat', typ: 'plantyp', dok: { Plankarta: 'plankarta_URL', Planbeskrivning: 'planbeskr_URL' } },
  '1452': { arcgis: 'https://gisportal.tranemo.se/arcgis/rest/services/Plan/Planområden/MapServer', lager: [0],
    planid: 'PLANBET', namn: 'PLNAMN', datum: 'LDAT', typ: 'PLANTYP', dok: { Planhandlingar: 'URL' } },
  '1461': { arcgis: 'https://services-eu1.arcgis.com/0nc1EbIdg7uqEhpW/arcgis/rest/services/Planlager_-_Mellerud/FeatureServer', lager: [0],
    planid: 'Aktnummer', namn: 'Namn', datum: 'LagaKraft' },
  '1471': { arcgis: 'https://geoportal.gotene.se/arcgis/rest/services/GIS/Planytor_NY/MapServer', lager: [0],
    planid: 'sde_gsd.GNG.plan_yta_1471.planbet', namn: 'sde_gsd.GNG.plan_yta_1471.plnamn', datum: 'sde_gsd.GNG.plan_yta_1471.ldat', typ: 'sde_gsd.GNG.plan_yta_1471.plantyp' },
  '1484': { arcgis: 'https://utility.arcgis.com/usrsvcs/servers/ab70cc12e2564d2a992085cba1b09edd/rest/services/LYK_ByggaBo/LYK_ByggaBo/MapServer', lager: [2],
    planid: 'PLANBET', namn: 'PLNAMN', datum: 'LDAT', typ: 'PLANTYP', dok: { Plankarta: 'Lank' } },
  '1497': { arcgis: 'https://gis.hjo.se/arcgis/rest/services/Plan/Detaljplaner/MapServer', lager: [1, 9], ...PLANMOSAIK,
    typ: (_p, lager) => lager === 9 ? 'OB' : 'DP' },
  '1498': { arcgis: 'https://geodata.tidaholm.se/arcgis/rest/services/Plan/Gällande_planer/MapServer', lager: [6], ...PLANMOSAIK },
  '2180': { arcgis: 'https://gis.gavle.se/server/rest/services/pbf_planering/planarkivet_gastrikland_f_d/MapServer', lager: [0], where: "KOMMUNKOD='2180'",
    planid: 'LMVAKT', namn: 'PLANNAMN', typ: 'OBJEKTTYP', dok: { Plankarta: 'SOKVAG_PDF_LOKAL' } },
  '2480': { sida: 'https://www.umea.se/byggaboochmiljo/oversiktsplanochdetaljplaner/detaljplanerochomradesbestammelser/gallandedetaljplanerochomradesbestammelser.4.7d7d901172bb372c5d2d7d.html', geojson: 'https://opendata.umea.se/api/explore/v2.1/catalog/datasets/gallande-detaljplaner/exports/geojson',
    lager: ['fil'], planid: 'aktbet', namn: 'popularnam', typ: 'kategori' },
  // Filer som kommunen själv skickat 2026-10-22 (svar på mejlet, se PRIVAT.md). Uppdateras bara när en ny fil kommer;
  // dygnsjobbet hoppar över dem. Mörbylånga: kommunens eget uttag ersätter den uteslutna karttjänsten.
  '0115': { fil: 'data/raw/kommunplaner/0115-vallentuna/Planer_Vallentuna_SWEREF991800/Planer_Vallentuna_SWEREF991800.shp', lager: ['fil'],
    planid: 'lmv_bet', namn: 'info_namn' },
  '0685': { kontrollera: true, fil: 'data/raw/kommunplaner/0685-vetlanda/detaljplaner_vetlanda.gpkg', lager: ['detaljplaner_l'],
    planid: 'LM_AKT_NR', namn: 'NAMN', datum: 'LAGAKRAFT', typ: 'Plantyp', hoppa: (p) => p.STATUS && p.STATUS !== 'Lagakraft',
    dok: { Plankarta: 'L_KARTA', Planbeskrivning: 'L_BESKRIVNING' } },
  '0821': { fil: 'data/raw/kommunplaner/0821-hogsby/Detaljplanomraden_Hogsby/Detaljplanomraden_Hogsby.shp', lager: ['fil'],
    planid: (p) => p.Name?.split('_')[0], namn: 'Descriptio', datum: 'LegallyBin', hoppa: (p) => p.PLANSTATUS && p.PLANSTATUS !== '6',
    dok: { Planhandlingar: 'LankTillPl' } },
  '0840': { fil: 'data/raw/kommunplaner/0840-morbylanga/antagnadp_20261022/antagnadp_20261022.shp', lager: ['fil'],
    planid: 'planbet', namn: 'Plannamn', datum: 'ldat', dok: { Plankarta: 'Lank' } },
  // Ängelholm 2026-10-23: planytor med plannummer, får publiceras. Ingen .prj: SWEREF 99 13 30 enligt koordinaterna.
  // En yta med två planer heter "B 153 & ÄDP 050" (planen och dess ändring); namn och datum finns inte i filen.
  '1292': { fil: 'data/raw/kommunplaner/1292-angelholm/DP_Planytor_med_nummer_y.shp', lager: ['fil'],
    projektion: { lon0: 13.5, k0: 1, FE: 150000 }, planid: 'STRING' },
  // Öppna källor som kommunen pekade på i sitt svar 2026-10-22.
  '2580': { sida: 'https://www.lulea.se/samhalle--utveckling/samhallsplanering/detaljplaner.html', arcgis: 'https://services.arcgis.com/f1FD2L08bel8cfME/arcgis/rest/services/GNG_gallande_detaljplaner/FeatureServer', lager: [0],
    planid: 'LM_AKT_NR', namn: 'PLANNAMN', datum: 'LAGA_KRAFT', typ: 'TYP_PLAN' },
  '0980': { sida: 'https://gotland.se/bygga-bo-och-miljo/samhallsplanering/oversiktsplan-och-detaljplaner', arcgis: 'https://services2.arcgis.com/DX6evuu0top9W2wh/arcgis/rest/services/Detaljplaner/FeatureServer', lager: [0],
    planid: 'planbet', namn: 'plnamn', datum: 'ldat', typ: 'plantyp' },
  // Tanum 2026-10-27: kommunen pekade på tjänsten ("ungefärliga digitala områden" för planer som inte finns i NGP).
  '1435': { arcgis: 'https://geodata.tanum.se/arcgis/rest/services/Bygga_och_bo/Bygga_och_bo/MapServer', lager: [4],
    planid: ['Planbeteckning_Lantamteriet', 'Plannummer'], datum: 'Laga_kraft', typ: 'Typkod',
    dok: { Plankarta: 'Lank_http1', Planbeskrivning: 'Lank_http2', Planhandling: 'Lank_http3' } },
  // Webbkartor som kommunen hänvisade till i sitt svar 2026-10-22. Bergslagen: gemensam tjänst för fyra kommuner.
  // Inte med: Trosa (bara WMS bakom inloggning, och kommunen ser över lagret före publik visning).
  ...Object.fromEntries([['1863', 'Hallefors'], ['1864', 'Ljusnarsberg'], ['1884', 'Nora'], ['1885', 'Lindesberg']].map(([kod, namn]) => [kod, {
    arcgis: 'https://gis.sb-bergslagen.se/arcgis/rest/services/Fysiskplanering/PlanOversikt/MapServer', lager: [0], where: `Kommunnamn='${namn}'`,
    planid: ['PlanID_LMV', 'PlanID_BMB'], datum: 'Laga_kraft', dok: { Plankarta: 'Plan_pdf', Planbeskrivning: 'Plan_text' } }])),
  '1981': { arcgis: 'https://geodata.sala.se/arcgis/rest/services/Detaljplaner/planomrade/MapServer', lager: [1],
    planid: ['LM_Plannr', 'Plannr'], namn: 'Plannamn', datum: 'Laga_kraft', typ: 'Plantyp', dok: { Planhandlingar: 'URL' } },
  '1984': { arcgis: 'https://geodata.arboga.se/arcgis/rest/services/DP/Detaljplaner_web/FeatureServer', lager: [0],
    planid: 'Planbeteck', hoppa: (p) => p.Status && p.Status !== 'Gällande', dok: { Plandokument: 'Länk' } },
  // Tjänsterna bakom kommunernas webbkartor, inventerade 2026-10-23 (data/planer-kommuner/webb-resultat-*.json).
  // Inte med: Borgholm (kommunen säger att den saknar egna plangränser och använder Lantmäteriets) och Tingsryd
  // (kommunen säger 2026-10-26 att plangränserna i tjänsten kommer från Lantmäteriet).
  '1266': { arcgis: 'https://karta.geoinfomittskane.se/arcgis/rest/services/Detaljplan/Detaljplaner_Horby/MapServer', lager: [12], utanId: true,
    planid: 'externid', namn: 'plnamn', datum: 'ldat', typ: 'planfk', dok: { Plankarta: 'Link' } },
  '1267': { arcgis: 'https://karta.geoinfomittskane.se/arcgis/rest/services/Detaljplan/Detaljplaner_Hoor/MapServer', lager: [20], utanId: true,
    planid: 'externid', namn: 'plnamn', datum: 'ldat', typ: 'planfk', dok: { Plankarta: 'URL' } },
  '0136': { wfs: 'https://karta.haninge.se/services/karta/ows', lager: ['planersutbredning_wfs'],
    planid: 'planbet_lokal', namn: 'plnamn', datum: 'ldat', typ: 'detaljtyp_namn', dok: { Planhandling: 'lank_dokument_ext' } },
  '0330': { kontrollera: true, arcgis: 'https://kartor.knivsta.se/arcgis/rest/services/Plan/Planoversikt_V2/MapServer', lager: [0], where: 'STATUS=0',
    planid: ['DPNR', 'SPID'], namn: 'DPNAMN', datum: 'LAGA_KRAFT_D', typ: 'PLANTYP', dok: { Planhandlingar: 'Planhandlingar' } },
  '0484': { sida: 'https://www.eskilstuna.se/bygga-bo-och-miljo/bygga-och-planera/stadsplanering/gallande-detaljplaner', wfs: 'https://karta.eskilstuna.se/geoserver/etuna/wfs', lager: ['etuna:sokvyx_zr_planarea'],
    planid: 'internaldocumentname', namn: 'title', datum: 'legallybindingdate', typ: 'style' },
  '0642': { wfs: 'https://karta.sweco.se/geoserver/Mullsjö/ows', lager: ['Mullsjö:karta_detaljplaner-gallande'],
    namn: 'namn', planid: (p) => p.link?.replace(/^akt_/i, '').replace(/(\.VOL\d+)?\.pdf$/i, '') },
  '0680': { wfs: 'https://karta.jonkoping.se/geoserver/ows', lager: ['HAJK:Detaljplaner_titta'],
    planid: 'LMAkt', namn: 'name', typ: 'Forkortning', dok: { Plankarta: 'link' } },
  '0834': { arcgis: 'https://gis.torsas.se/arcgis/rest/services/bygg_miljo2/DP_alla/MapServer', lager: [8], ...PLANMOSAIK },
  '0862': { kontrollera: true, arcgis: 'https://kartor.emmaboda.se/arcgis/rest/services/Planer_och_pågående_plan_projekt/MapServer', lager: [0],
    planid: 'PLANBET', namn: 'PLNAMN', typ: 'PLANTYP', dok: { Plankarta: 'Link' } },
  '1233': { arcgis: 'https://services3.arcgis.com/V1E24miEW9adAZYb/arcgis/rest/services/Detaljplaner_II/FeatureServer', lager: [0],
    planid: 'Namn', namn: 'Beskrivning', typ: 'Typ' },
  '1285': { arcgis: 'https://kartportal.eslov.se/arcgis/rest/services/kommun/gallande_detaljplaner/MapServer', lager: [0], where: "skede='gallande'",
    planid: 'plannummer_ek', namn: 'namn', datum: 'antagen_ar', typ: 'plantyp', dok: { Plankarta: 'lank_detaljplan' } },   // antagen_ar: laga kraft-år enligt aliaset
  '1290': { wfs: 'https://kartor.kristianstad.se/qgisserver-shared/ows/planer', lager: ['v_plan_lk_dig'],
    planid: 'beteckning', namn: 'namn', datum: 'lagakraft', typ: 'typ', dok: { Plankarta: 'file' } },
  '1381': { arcgis: 'https://kartor.laholm.se/arcgis/rest/services/gis/Detaljplan_pro/MapServer', lager: [0],
    planid: 'PLANBET', namn: 'PLNAMN', typ: 'PLANTYP', dok: { Plankarta: 'karta' } },
  '1383': { wfs: 'https://wms.varberg.se/geoserver/sbk_plan_pdb_v1/wfs', lager: ['sbk_plan_pdb_v1:pdb_planomrade_yta'],
    planid: 'beteckning', namn: 'namn', typ: 'plantyp', hoppa: (p) => p.planstatus && p.planstatus !== 'laga kraft' },
  '1402': { arcgis: 'https://geodata.partille.se/arcgis/rest/services/gallande_detaljplaner_publik/MapServer', lager: [0],
    planid: 'plannr', namn: 'plannamn', datum: 'lagakraft', typ: 'plantyp', dok: { Plankarta: 'plankarta' } },
  '1421': { arcgis: 'https://services2.arcgis.com/1Nvz85KbF7OLwYjb/arcgis/rest/services/Gallande_detaljplaner/FeatureServer', lager: [0],
    planid: 'Plan_Nr', namn: 'Benämning', datum: 'Laga_kraft', dok: { Plankarta: 'Links_1' } },
  '1427': { arcgis: 'https://services7.arcgis.com/jFiNkvhOzEXq569w/arcgis/rest/services/Bygga_Bo/FeatureServer', lager: [8],
    planid: 'PLANBET', namn: 'PLNAMN', typ: 'PLANTYP', dok: { Plankarta: 'http_lank' } },
  '1430': { arcgis: 'https://geodata-munkedal.sml-it.se/arcgis/rest/services/Detaljplaner_fast/MapServer', lager: [0],
    planid: 'PLANBET', namn: 'PLNAMN', typ: 'PLANTYP', dok: { Plankarta: 'http_adres' } },
  '1439': { arcgis: 'https://services3.arcgis.com/fjMqzfeHWdE2NsMQ/arcgis/rest/services/Plangränser/FeatureServer', lager: [0],
    planid: 'PLANBET', namn: 'PLNAMN', typ: 'PLANTYP', dok: { Plankarta: 'Länk' } },
  '1442': { arcgis: 'https://gisportal.hervar.se/arcgis/rest/services/Samhällsplanering/Detaljplaner_vga/MapServer', lager: [8],
    ...PLANMOSAIK, planid: 'Name', namn: 'Description' },
  '1445': { arcgis: 'https://geoportal.goliska.se/arcgis/rest/services/Essunga/Planer_Essunga/MapServer', lager: [0],
    planid: 'ARKIVNUMMER', namn: 'Planens_namn', datum: 'Laga_kraft', typ: 'PLANTYP', dok: { Plankarta: 'Ext_lank' } },
  '1465': { arcgis: 'https://maps.svenljunga.se/server/rest/services/Detaljplaner_PDF_MIL1/MapServer', lager: [0], planid: 'PLANBET', namn: 'IntNamn' },
  '1762': { arcgis: 'https://services3.arcgis.com/DlbZcscGstAa5ye2/arcgis/rest/services/Detaljplaner_i_Munkfors_kommun/FeatureServer', lager: [0],
    planid: 'planbet', namn: 'plnamn', typ: 'plantyp' },
  '1765': { arcgis: 'https://services7.arcgis.com/g5VIBBqp2B0hyHxB/arcgis/rest/services/Detaljplaner/FeatureServer', lager: [0],
    planid: 'PLANBET', namn: 'PLNAMN', typ: 'PLANTYP', dok: { Plankarta: 'Lank' } },
  '1861': { arcgis: 'https://karta.kumla.se/arcgis/rest/services/ByggaBo_Hallsberg/ByggaBo_Hallsberg/MapServer', lager: [1],
    planid: 'planbet', namn: 'plnamn', datum: 'ldat', typ: 'plantyp' },
  '1907': { arcgis: 'https://gis.surahammar.se/arcgis/rest/services/webbkarta/Detaljplanoversikt_pdf/MapServer', lager: [172], planid: 'Name' },
  '1960': { kontrollera: true, arcgis: 'https://geodata.kungsor.se/arcgis/rest/services/Planmosaik/MapServer', lager: [0],
    planid: 'PLANNUMMER', namn: 'Namn', dok: { Plankarta: 'Hyperlink1' } },
  '1961': { wfs: 'https://karta.hallstahammar.se/geoserver/wfs', lager: ['Hallstahammar:db_v_mosaik_plan_y'],
    planid: 'dp_planid', namn: 'dp_plannamn', datum: 'senaste_datumlagakraft', typ: 'dp_ursprungligplantyp',
    hoppa: (p) => p.dp_registerstatus !== 'g' || p.dp_forslag !== 'N' },
  // Västmanland-Dalarna miljö- och byggförvaltning: ett lager per kommun. Dokumentfälten är HTML-länkar.
  ...Object.fromEntries([['1962', 'n', 'text'], ['1982', 'f', 'planrubrik'], ['2084', 'a', 'text']].map(([kod, bokstav, namn]) => [kod, {
    kontrollera: true, wfs: 'https://karta.vdmb.se/geoserver/db_gamla/wfs', lager: [`db_gamla:dp_plangrans_y_${bokstav}`],
    planid: 'plannr', namn, datum: 'lagakraft', typ: 'dp_plantyp',
    dok: { Plankarta: 'plankarta', Planbeskrivning: 'plandok1', Handling: 'plandok2' } }])),
  '2029': { wfs: 'https://karta.leksand.se/geoserver/adm-karta/ows', lager: ['adm-karta:plangranser_ytor_m_lagerextern'],
    planid: 'layer', dok: { Plankarta: 'externlink' } },
  // Västra Gästriklands planarkiv (inte VGS nedladdningsfil, som är Lantmäteriets registerkarta).
  ...Object.fromEntries([['2101', 'OCKELBO'], ['2104', 'HOFORS']].map(([kod, namn]) => [kod, {
    arcgis: 'https://gis.sandviken.se/server/rest/services/Planarkiv/FeatureServer', lager: [2], where: `kommun='${namn}' AND statuskod='B'`,
    planid: 'akt', namn: 'plannamn', datum: 'lagakraftdatum', typ: 'plantyp', dok: { Plankarta: 'pdf_plats' } }])),
  '2182': { arcgis: 'https://gis.soderhamn.se/arcgis/rest/services/Detaljplan/Detaljplan_ytor/FeatureServer', lager: [0],
    planid: 'Plannummer', namn: 'Namn', typ: 'Typ_av_plan' },
  '2184': { arcgis: 'https://gis.hudiksvall.se/arcgis/rest/services/Avd_PlanBygg/Avd_PlanBygg_Planer_Ext/MapServer', lager: [0],
    planid: 'planbet', namn: 'plnamn', typ: 'plantyp' },
  '2581': { sida: 'https://www.pitea.se/Medborgarservice/kartoradresser-och-geografisk-information/karttjanster/digitala-kartor/', arcgis: 'https://gisportal.pitea.se/arcgis/rest/services/PK/PK_Detaljplaner_Omradesbestammelser_publikt/MapServer', lager: [2, 4],
    planid: 'planbet', namn: 'PLANNAMN', typ: (p, lager) => lager === 4 ? 'OB' : p.plantyp },
  '2582': { kontrollera: true, arcgis: 'https://gisportal.boden.se/server/rest/services/DB_SDE_GEOPLAN_BODEN/BK_DP_PLANMOSAIK_GALLANDE/MapServer', lager: [32],
    ...PLANMOSAIK, namn: 'Description', dok: { Plandokument: 'DocumentLinksWebHtml' } },
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

async function hamtaArcgis(bas, lager, request, where = '1=1', utanId = false) {
  const url = `${encodeURI(bas)}/${lager}/query`;
  // Vyer där samma objekt kommer en gång per dokumentlänk (Hörby, Höör): allt i ett svar, räknat mot antalet,
  // och första raden per OBJECTID.
  if (utanId) {
    const q = `${url}?where=${encodeURIComponent(where)}`;
    const { count } = await hamtaJson(`${q}&returnCountOnly=true&f=json`, request);
    const d = await hamtaJson(`${q}&outFields=*&outSR=4326&f=json`, request);
    if (d.error || !Array.isArray(d.features)) throw new Error(`ArcGIS-lager ${lager}: ${d.error?.message ?? 'ogiltigt svar'}`);
    if (d.exceededTransferLimit || d.features.length !== count) throw new Error(`ArcGIS-lager ${lager}: ofullständigt svar (${d.features.length} av ${count})`);
    const forsta = new Map();
    for (const f of d.features) if (!forsta.has(f.attributes.OBJECTID)) forsta.set(f.attributes.OBJECTID, f);
    return [...forsta].map(([id, f]) => ({ id, p: f.attributes, g: esriTillGeojson(f.geometry) }));
  }
  const ids = await hamtaJson(`${url}?where=${encodeURIComponent(where)}&returnIdsOnly=true&f=json`, request);
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

// En öppen GeoJSON-fil i WGS84 (Helsingborg, Umeå).
// En fil som kommunen skickat (Shape eller GeoPackage i data/raw), omräknad från SWEREF 99 till WGS84.
function lasFil(fil, lager, projektion) {
  const sokvag = join(ROOT, fil);
  if (/\.shp$/i.test(sokvag)) {
    const las = lasShape(sokvag);
    const { lon0, k0, FE } = Number.isFinite(las.projektion.lon0) ? las.projektion : projektion ?? {};
    const { objekt } = las;
    if (![lon0, k0, FE].every(Number.isFinite)) throw new Error(`${fil}: okänd projektion i .prj`);
    return objekt.map(({ id, p, rings }) => ({ id, p,
      g: esriTillGeojson({ rings: rings.map((r) => r.map(([x, y]) => sweref99ToWgs84(x, y, lon0, k0, FE))) }) }));
  }
  const db = new DatabaseSync(sokvag, { readOnly: true });
  try {
    const { srs_id: srs } = db.prepare('SELECT srs_id FROM gpkg_contents WHERE table_name = ?').get(lager) ?? {};
    if (srs !== 3006 && !SWEREF_LOKAL[srs]) throw new Error(`${fil}: koordinatsystem ${srs} stöds inte`);
    const omrakna = srs === 3006 ? ([x, y]) => sweref99ToWgs84(x, y) : ([x, y]) => sweref99ToWgs84(x, y, SWEREF_LOKAL[srs], 1, 150000);
    const kol = db.prepare('SELECT column_name FROM gpkg_geometry_columns WHERE table_name = ?').get(lager).column_name;
    return db.prepare(`SELECT * FROM "${lager}"`).all().map((r, i) => {
      const { [kol]: geom, ...p } = r;
      const g = parseGpkgGeometry(geom);
      return { id: r.fid ?? i, p, g: g && mapCoords(g, omrakna) };
    });
  } finally { db.close(); }
}

async function hamtaGeojson(url, request) {
  const d = await hamtaJson(url, request);
  if (d.type !== 'FeatureCollection' || !Array.isArray(d.features)) throw new Error('GeoJSON: ogiltigt svar');
  return d.features.map((f, i) => ({ id: i, p: f.properties ?? {}, g: f.geometry }));
}

async function hamtaWfs(bas, lager, request) {
  const url = new URL(bas);
  // QGIS Server (Haninge, Kristianstad) kräver TYPENAME även i WFS 2.0.0.
  for (const [k, v] of Object.entries({ service: 'WFS', version: '2.0.0', request: 'GetFeature', typeNames: lager, typeName: lager,
    outputFormat: 'application/json', srsName: 'EPSG:4326' })) url.searchParams.set(k, v);
  const d = await hamtaJson(url.href, request);
  if (d.type !== 'FeatureCollection' || !Array.isArray(d.features)) throw new Error(`WFS ${lager}: ogiltigt svar`);
  if (Number.isFinite(d.numberMatched) && d.numberMatched > d.features.length) throw new Error(`WFS ${lager}: bara ${d.features.length} av ${d.numberMatched} objekt`);
  return d.features.map((f, i) => ({ id: f.id ?? i, p: f.properties ?? {}, g: f.geometry }));
}

// Fungerar länken utifrån? En fil som i stället ger en HTML-sida (inloggning, felsida) räknas som trasig.
// En server som inte svarar alls prövas inte igen under samma import.
async function fungerar(url, request, doda) {
  const vard = new URL(url).host;
  if (doda.has(vard)) return false;
  await setTimeout(100);
  try {
    const r = await request(url, { headers: { ...UA, range: 'bytes=0-1023' }, signal: AbortSignal.timeout(15_000) });
    const typ = r.headers.get('content-type') ?? '';
    await r.body?.cancel().catch(() => {});
    return r.ok && !(/\.(pdf|jpe?g|png|tiff?)\.?$/i.test(new URL(url).pathname) && typ.includes('html'));
  } catch { doda.add(vard); return false; }
}

export async function hamtaKommunplaner(kod, request = fetch) {
  const k = KALLOR[kod];
  if (!k) throw new Error(`Ingen karttjänst inlagd för ${kod}.`);
  const doda = new Set();
  const rader = [], sedda = new Set();
  let utanGeometri = 0;
  for (const lager of k.lager) {
    const objekt = k.arcgis ? await hamtaArcgis(k.arcgis, lager, request, k.where, k.utanId)
      : k.fil ? lasFil(k.fil, lager, k.projektion)
      : k.geojson ? await hamtaGeojson(k.geojson, request) : await hamtaWfs(k.wfs, lager, request);
    for (const { id, p, g } of objekt) {
      // Samma id två gånger skulle skriva över planer; då stoppas kommunen hellre.
      if (id == null || sedda.has(`${lager}:${id}`)) throw new Error(`lager ${lager}: saknat eller upprepat objekt-id (${id})`);
      sedda.add(`${lager}:${id}`);
      if (k.hoppa?.(p)) continue;
      const geom = rensaGeometri(g);
      if (!geom) { utanGeometri++; continue; }
      // Ett fält eller en funktion; fältet kan ha flera adresser på egna rader eller vara HTML med <a href>.
      const dok = Object.entries(k.dok ?? {}).flatMap(([titel, f]) => {
        const v = String((typeof f === 'function' ? f(p) : p[f]) ?? '');
        // HTML: länktexten blir rubriken (Plankarta, Planbeskrivning …).
        const lankar = /href\s*=/i.test(v)
          ? [...v.matchAll(/<a\s[^>]*?href\s*=\s*["']([^"']+)["'][^>]*>([^<]*)</gi)].map((m) => [m[1].replace(/&amp;/g, '&'), m[2].trim() || titel])
          : v.split(/[\r\n]+/).map((u) => [u, titel]);
        // Windows-sökvägar i adressen (Avesta: "Plan/Avesta\G48\…") blir snedstreck, som i webbläsaren.
        return lankar.map(([u, t]) => [u.trim().replace(/\\/g, '/'), t]).filter(([u]) => /^https:\/\/[^"<>\\]+$/.test(u)).map(([u, t]) => ({ titel: t, url: kodaUrl(u) }));
      });
      // Ett uppslag per plan (Malmö): ett fel stoppar kommunen hellre än att länkarna försvinner.
      if (k.dokSok) { await setTimeout(150); dok.push(...await k.dokSok(p, request)); }
      // Kommuner där stickprov gav trasiga länkar (2026-10-23): varje länk prövas, bara de som fungerar sparas.
      if (k.kontrollera) for (const d of [...dok]) if (!await fungerar(d.url, request, doda)) dok.splice(dok.indexOf(d), 1);
      // Utan länkar per plan: kommunens sida om gällande planer.
      if (!dok.length && k.sida) dok.push({ titel: 'Gällande planer hos kommunen', url: k.sida });
      rader.push({ id: `kommun:${kod}:${lager}:${id}`, typ: plantyp(falt(p, k.typ, lager) ?? lager), planid: text(falt(p, k.planid, lager)),
        namn: text(falt(p, k.namn, lager)), datum: datum(falt(p, k.datum, lager)), kommun: kod, geojson: JSON.stringify(geom),
        ...geomBbox(geom), dokument: dok.length ? JSON.stringify([...new Map(dok.map((d) => [d.url, d])).values()].slice(0, 4)) : null });
    }
  }
  return { rader, utanGeometri };
}

// En kommun som tagits bort ur KALLOR (invändning, Lantmäteriets data) försvinner ur databasen vid nästa körning.
export function utanKallaBort(db) {
  const koder = Object.keys(KALLOR);
  return Number(db.prepare(`DELETE FROM plan WHERE kalla = 'kommun' AND kommun NOT IN (${koder.map(() => '?').join(',')})`).run(...koder).changes);
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
