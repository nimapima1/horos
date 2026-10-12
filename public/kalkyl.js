// Kassaflödeskalkyl för scenarier, utan DOM: används av panel.js och testas i test/kalkyl.test.mjs.
// Samma uppställning som en vanlig kassaflödesvärdering: hyra per lokalslag minus vakans, drift och
// underhåll, fastighetsskatt och tomträttsavgäld ger driftnettot; värdet är driftnettona under
// kalkylperioden plus ett restvärde (året efter perioden / direktavkastningskravet), nuvärdesberäknade.

// Kalkylens rader i visningsordning: [nyckel, rubrik, summarad].
const KALKYL_RADER = [['hyra', 'Hyresintäkter'], ['vakans', 'Vakans'], ['netto', 'Nettointäkter', true],
  ['drift', 'Drift'], ['uh', 'Underhåll'], ['skatt', 'Fastighetsskatt'], ['avgald', 'Tomträttsavgäld'],
  ['dn', 'Driftnetto', true]];

const procentTal = (v) => (Number(v) || 0) / 100;

// Fastighetsskatt per år (kr) från taxeringsvärdet: 1 % för lokaler, 0,5 % för industri, 0,3 % för bostäder.
// shortcut: bostäder har en avgift per lägenhet med 0,3 % som tak, och nybyggda är befriade; antalet lägenheter
// finns inte i Horos, så taket används. "Bostäder och lokaler" får 1 % eftersom fördelningen mellan delarna saknas;
// ta in bostads- och lokalvärdet var för sig när taxeringen har dem. Användaren kan skriva in det riktiga beloppet.
function standardSkatt(f) {
  const t = (f.typ ?? '').toLowerCase();
  const sats = t.includes('industri') ? 0.005 : t.includes('lokal') ? 0.01 : t.includes('bostad') || t.includes('bostäder') ? 0.003 : 0;
  return Math.round((f.varde_tkr ?? 0) * 1000 * sats);
}

// Ytan per lokalslag: användarens egna värden, annars den uppskattade LOA:n från företagen på fastigheten.
const ytor = (f, egna) => ({ ...f.loa, ...egna?.yta });

// s: scenariot (se nyttScenario i panel.js), fastigheter: underlaget från /api/underlag.
// Returnerar år, rader per fastighet och totalt (kr per år, ar + 1 kolumner där den sista är restvärdesåret)
// och värdet; värdet är null utan direktavkastningskrav.
function berakna(s, fastigheter) {
  const n = s.ar, g = s.gemensamt;
  const hu = procentTal(g.hyresutv), ku = procentTal(g.kostutv), da = procentTal(g.direktavk);
  const r = g.kalkylranta != null ? procentTal(g.kalkylranta) : da + hu;   // kalkylränta = direktavkastning + inflation
  const tom = () => Object.fromEntries(KALKYL_RADER.map(([k]) => [k, Array(n + 1).fill(0)]));
  const total = tom();
  let yta = 0;
  const per = fastigheter.map((f) => {
    const e = s.egna[f.beteckning] ?? {}, rad = tom(), y = ytor(f, e);
    const fastYta = Object.values(y).reduce((a, m2) => a + (Number(m2) || 0), 0);
    yta += fastYta;
    for (let ar = 0; ar <= n; ar++) {
      for (const [slag, m2] of Object.entries(y)) {
        const a = s.antaganden[slag] ?? {}, m = Number(m2) || 0;
        const hyra = m * (Number(a.hyra) || 0) * (1 + hu) ** ar;
        rad.hyra[ar] += hyra;
        rad.vakans[ar] -= hyra * procentTal(a.vakans);
        rad.drift[ar] -= m * (Number(a.drift) || 0) * (1 + ku) ** ar;
        rad.uh[ar] -= m * (Number(a.uh) || 0) * (1 + ku) ** ar;
      }
      rad.skatt[ar] = -(Number(e.skatt ?? standardSkatt(f)) || 0);   // e kan komma från en handredigerad fil
      rad.avgald[ar] = -(Number(e.avgald) || 0);
      rad.netto[ar] = rad.hyra[ar] + rad.vakans[ar];
      rad.dn[ar] = rad.netto[ar] + rad.drift[ar] + rad.uh[ar] + rad.skatt[ar] + rad.avgald[ar];
    }
    for (const [k] of KALKYL_RADER) rad[k].forEach((v, i) => { total[k][i] += v; });
    return { beteckning: f.beteckning, yta: fastYta, rader: rad, varde: nuvarde(rad.dn, n, r, da) };
  });
  return { ar: Array.from({ length: n + 1 }, (_, i) => s.start + i), per, total, yta, kalkylranta: r,
    varde: nuvarde(total.dn, n, r, da) };
}

// Scenariot ihoplagt med andra (s.delar, valda under kassaflödet): delar med roll "med" räknas med sina egna
// antaganden men scenariots startår och kalkylperiod, så att åren går att summera; delar med roll "minus" dras
// ifrån, dvs. deras fastigheter räknas inte alls. En fastighet räknas en gång: i scenariot självt, annars i den
// första delen där den finns. Samma form som berakna (total, per, varde …) plus delar: [{namn, nyckel, antal, yta,
// taxering_tkr, k}] (scenariot först) och bort: [{nyckel, antal}] (antal fastigheter som dragits ifrån).
// Värdet är null om någon del med fastigheter saknar direktavkastningskrav.
function beraknaPortfolj(s, fastigheter) {
  const perBet = new Map(fastigheter.map((f) => [f.beteckning, f]));
  const minus = (s.delar ?? []).filter((d) => d.roll === 'minus');
  const raknade = new Set(minus.flatMap((d) => d.bet));   // dragna ifrån: räknas aldrig
  const delar = [{ namn: s.namn, nyckel: null, data: s }, ...(s.delar ?? []).filter((d) => d.roll !== 'minus')
    .map((d) => ({ namn: d.namn, nyckel: d.nyckel, data: { ...d, start: s.start, ar: s.ar } }))]
    .map(({ namn, nyckel, data }) => {
      const egna = data.bet.filter((b) => perBet.has(b) && !raknade.has(b) && raknade.add(b)).map((b) => perBet.get(b));
      const k = berakna({ gemensamt: {}, antaganden: {}, egna: {}, ...data }, egna);
      return { namn, nyckel, antal: egna.length, yta: k.yta, taxering_tkr: egna.reduce((a, f) => a + (f.varde_tkr ?? 0), 0), k };
    });
  // Hur många fastigheter varje avdragen del tar bort ur det som annars hade räknats.
  const annars = new Set([s, ...(s.delar ?? []).filter((d) => d.roll !== 'minus')].flatMap((d) => d.bet).filter((b) => perBet.has(b)));
  const bort = minus.map((d) => ({ nyckel: d.nyckel, antal: d.bet.filter((b) => annars.has(b)).length }));
  const [huvud] = delar;
  const total = Object.fromEntries(KALKYL_RADER.map(([r]) => [r, huvud.k.total[r].map((_, i) => delar.reduce((a, d) => a + d.k.total[r][i], 0))]));
  return { ...huvud.k, total, delar, bort, per: delar.flatMap((d) => d.k.per), yta: delar.reduce((a, d) => a + d.yta, 0),
    varde: delar.some((d) => d.antal && d.k.varde == null) ? null : delar.reduce((a, d) => a + (d.k.varde ?? 0), 0) };
}

// Driftnettona år 1..n diskonterade med r, plus restvärdet (driftnettot år n + 1 / da) diskonterat n år.
function nuvarde(dn, n, r, da) {
  if (!(da > 0) || r <= -1) return null;
  let v = 0;
  for (let i = 0; i < n; i++) v += dn[i] / (1 + r) ** (i + 1);
  return v + dn[n] / da / (1 + r) ** n;
}

// Nyckeltal för första året: direktavkastning på värdet, vakanstålighet (hur hög vakansen kan bli innan
// driftnettot är noll) och drift- och underhållstålighet (hur mycket kostnaderna kan öka), som andelar.
function nyckeltal(k) {
  const t = k.total, dou = -(t.drift[0] + t.uh[0]);
  return {
    direktavkastning: k.varde > 0 ? t.dn[0] / k.varde : null,
    vakans: t.hyra[0] ? -t.vakans[0] / t.hyra[0] : null,
    vakanstalighet: t.hyra[0] ? (t.dn[0] - t.vakans[0]) / t.hyra[0] : null,
    doutalighet: dou ? t.dn[0] / dou : null,
  };
}
