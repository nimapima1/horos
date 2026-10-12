// Scenarier: egna kassaflödeskalkyler för en grupp fastigheter (som Datschas "Scenarion"), utan inloggning.
// Ett scenario sparas som kort länk (/api/scenario; id:t är en hash av innehållet, så en delad länk ändras
// aldrig), eller i själva länken (#sd=) om servern inte kan spara. Alla scenarier finns i Mina scenarion i
// webbläsaren och sparas där vid varje ändring; ett av dem är öppet och tar emot det som läggs till. Scenariot
// kan också laddas ner och öppnas som fil. Bara deklarationer; app.js kopplar in dem.

let scenario = null;     // öppet scenario: { data, underlag, saknas, byggd, nyckel, lank }
let bolagUrval = null;   // senast öppnade bolagets fastigheter, för "Räkna på innehavet" (se openBolag)

const nyttScenario = (namn, bet) => ({ v: 1, namn: String(namn).slice(0, 100), start: new Date().getFullYear(), ar: 5,
  bet: [...new Set(bet)], gemensamt: { hyresutv: 2, kostutv: 2 }, antaganden: {}, egna: {} });
const lokalslag = (s) => ['Bostäder', ...s.lokaltyper];
const ANTAGANDEN = [['hyra', 'Hyra, kr/m²', 't.ex. 2 000'], ['vakans', 'Vakans, %', '0'], ['drift', 'Drift, kr/m²', '0'], ['uh', 'Underhåll, kr/m²', '0']];
const normBet = (b) => String(b).trim().replace(/\s+/g, ' ').toUpperCase();   // som normBeteckning på servern
const objekt = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
// Ett delscenario: en kopia av ett annat scenarios fastigheter och antaganden (nyckel: scenariot i Mina scenarion).
const delAv = (x, nyckel) => ({ nyckel: nyckel ?? null, namn: String(x.namn ?? '').slice(0, 100),
  bet: [...new Set(x.bet.filter((b) => typeof b === 'string').map(normBet))],
  gemensamt: objekt(x.gemensamt), antaganden: objekt(x.antaganden), egna: objekt(x.egna) });
// Alla fastigheter i portföljen: scenariots egna och delscenariernas, var och en en gång.
const allaBet = (d) => [...new Set([...d.bet, ...(d.delar ?? []).flatMap((x) => x.bet)])];

// Mina scenarion: [{nyckel, namn, data, lank, andrad, antal}], senast använda först (andrad = senast öppnat eller ändrat). lank är den delade länken,
// null om scenariot har ändrats sedan dess. horos.aktivt är nyckeln till det öppna scenariot.
// shortcut: högst 50 scenarier, det äldsta faller bort tyst; varna om någon når gränsen.
const minaScenarion = () => { try { return JSON.parse(store.get('horos.scenarion')) ?? []; } catch { return []; } };
const sparaMina = (l) => store.set('horos.scenarion', JSON.stringify(l.slice(0, 50)));
let sparatLokalt = true;   // senaste sparningen i webbläsaren lyckades (se #sc-varning)
function sparaLokalt() {
  if (!scenario) return store.set('horos.aktivt', '');
  const d = scenario.data;
  sparatLokalt = sparaMina([{ nyckel: scenario.nyckel, namn: d.namn, data: d, lank: scenario.lank, andrad: new Date().toISOString().slice(0, 10), antal: d.bet.length },
    ...minaScenarion().filter((x) => x.nyckel !== scenario.nyckel)]) && store.set('horos.aktivt', scenario.nyckel);
  // Full eller avstängd lagring (vissa privata lägen): säg det, annars försvinner scenariot tyst vid omladdning.
  const varning = $('#sc-varning');
  if (varning) varning.hidden = sparatLokalt;
  ritaScenarier();
}

// Scenarierna på kartan: de som är ibockade i Mina scenarion (horos.synliga) och det öppna, med var sin färg
// efter platsen i den listan. Prickar under zoom 14, gränser över; vitt där en fastighet finns i flera.
const SC_FARGER = ['--c3', '--c4', '--c6', '--c5', '--c2'];   // inte --c1: kartans egna kluster är blå
const synliga = () => { try { return JSON.parse(store.get('horos.synliga')) ?? []; } catch { return []; } };
const sattSynliga = (l) => store.set('horos.synliga', JSON.stringify(l));
const paKartan = () => [...new Set([...synliga(), ...(scenario ? [scenario.nyckel] : [])])];
const fargPa = (nyckel) => SC_FARGER[Math.max(0, paKartan().indexOf(nyckel)) % SC_FARGER.length];
const mitten = (f) => [(f.minx + f.maxx) / 2, (f.miny + f.maxy) / 2];
const mittpunkter = new Map();   // beteckning -> [lon, lat], eller null om fastigheten inte finns i Horos
const OSYNLIG = 'rgba(0,0,0,0)';
async function ritaScenarier() {
  if (!map.getSource('scenarier')) return;   // kartan laddas fortfarande; load ritar
  const mina = minaScenarion();
  const vis = paKartan().map((n) => (n === scenario?.nyckel ? { nyckel: n, namn: scenario.data.namn, bet: allaBet(scenario.data) }
    : ((m) => m?.data && { nyckel: n, namn: m.namn, bet: allaBet(m.data) })(mina.find((m) => m.nyckel === n)))).filter(Boolean);
  const saknas = [...new Set(vis.flatMap((v) => v.bet))].filter((b) => !mittpunkter.has(b));
  try {
    for (let i = 0; i < saknas.length; i += 1000) {
      const del = saknas.slice(i, i + 1000), r = await api('/api/underlag', { bet: del });
      for (const b of del) mittpunkter.set(b, null);
      for (const f of r.fastigheter) mittpunkter.set(f.beteckning, mitten(f));
    }
  } catch { return; }   // ritas nästa gång något ändras
  const farger = new Map();   // beteckning -> färgerna för scenarierna den finns i
  for (const v of vis) for (const b of v.bet) (farger.get(b) ?? farger.set(b, []).get(b)).push(css(fargPa(v.nyckel)));
  map.getSource('scenarier').setData({ type: 'FeatureCollection', features: [...farger].filter(([b]) => mittpunkter.get(b))
    .map(([b, f]) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: mittpunkter.get(b) }, properties: { farg: f[0], flera: f.length > 1 } })) });
  const grupper = new Map();   // linjefärg -> beteckningar
  for (const [b, f] of farger) { const c = f.length > 1 ? '#FFFFFF' : f[0]; (grupper.get(c) ?? grupper.set(c, []).get(c)).push(b); }
  map.setPaintProperty('scenario-line', 'line-color', grupper.size
    ? ['match', ['get', 'beteckning'], ...[...grupper].flatMap(([c, l]) => [l, c]), OSYNLIG] : OSYNLIG);
  map.setFilter('scenario-line', ['in', ['get', 'beteckning'], ['literal', [...farger.keys()]]]);
  const flera = [...farger.values()].some((f) => f.length > 1);
  $('#legend-scenarier').hidden = !vis.length;
  $('#legend-scenarier').innerHTML = vis.map((v) => `<span><i style="background:var(${fargPa(v.nyckel)})"></i>${esc(v.namn || 'Namnlöst scenario')}</span>`).join('')
    + (flera ? '<span><i class="flera"></i>I flera scenarier</span>' : '');
}
function vaxlaSynlig(nyckel, pa) {
  sattSynliga(pa ? [...new Set([...synliga(), nyckel])] : synliga().filter((n) => n !== nyckel));
  ritaScenarier();
  openScenarier({ lista: true });   // färgerna följer ordningen
}
// Läser in det öppna scenariot efter en omladdning, utan att byta vy, så att + och Lägg till fungerar direkt.
function aterstallAktivt() {
  const x = minaScenarion().find((m) => m.nyckel === store.get('horos.aktivt'));
  if (x && !scenario) oppnaPost(x, { visa: false }).catch(() => {});
}
// Gör ett scenario i listan till det öppna (laddar underlaget); visa: byt panelen till scenariot.
async function oppnaPost(x, { visa = true } = {}) {
  const data = x.data ?? (x.lank ? await hamtaLank(new URL(x.lank).hash) : null);
  return oppnaScenario(data, { nyckel: x.nyckel, lank: x.lank, visa });
}

// Scenariot i länken: JSON, komprimerat (deflate) och base64url.
async function packa(obj) {
  const b = new Uint8Array(await new Response(new Blob([JSON.stringify(obj)]).stream().pipeThrough(new CompressionStream('deflate-raw'))).arrayBuffer());
  let s = '';
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
async function packaUpp(text) {
  const b = Uint8Array.from(atob(text.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
  return JSON.parse(await new Response(new Blob([b]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).text());
}
const arScenarioLank = (h) => /^#sd?=/.test(h);
const kortLank = (hash) => `${location.origin}${location.pathname}${hash}`;

// Öppnar scenariot (data i formatet från nyttScenario, t.ex. från en länk eller fil) med underlaget från servern,
// och lägger det i Mina scenarion om det inte redan finns där.
async function oppnaScenario(data, { nyckel, lank, visa = true } = {}) {
  if (data?.v !== 1 || !Array.isArray(data.bet)) return showPanel('<p class="empty">Det här är inte ett scenario från Horos.</p>');
  const s = await statusP;
  // Länkar och filer kommer utifrån: fyll i det som saknas och håll år och period inom rimliga gränser.
  const d = { ...nyttScenario('', []), ...data };
  d.bet = [...new Set(d.bet.filter((b) => typeof b === 'string').map(normBet))].slice(0, s.maxScenario);
  d.ar = Math.min(10, Math.max(1, Math.round(d.ar) || 5));
  d.start = Math.min(2100, Math.max(1900, Math.round(d.start) || new Date().getFullYear()));
  for (const k of ['gemensamt', 'antaganden', 'egna']) if (typeof d[k] !== 'object' || !d[k]) d[k] = {};
  // Delscenarier (Addera): finns delen kvar i Mina scenarion räknas dess senaste version, annars kopian i scenariot.
  const mina = minaScenarion();
  d.delar = (Array.isArray(d.delar) ? d.delar : []).filter((x) => Array.isArray(x?.bet)).map((x) => {
    const senaste = x.nyckel && x.nyckel !== nyckel && mina.find((m) => m.nyckel === x.nyckel)?.data;
    return delAv(senaste || x, x.nyckel);
  });
  let u;
  try { u = await api('/api/underlag', { bet: allaBet(d).slice(0, s.maxScenario) }); } catch (e) {
    if (!visa) throw e;   // i bakgrunden (+-menyn): den som anropade visar felet
    return showPanel(`<p class="empty">${esc(e.message)}</p>`);
  }
  const finns = new Set(u.fastigheter.map((f) => f.beteckning));
  for (const f of u.fastigheter) mittpunkter.set(f.beteckning, mitten(f));
  scenario = {
    data: d, underlag: u.fastigheter.sort((a, b) => (b.varde_tkr ?? 0) - (a.varde_tkr ?? 0)),
    saknas: allaBet(d).filter((b) => !finns.has(b)), byggd: u.byggd,
    nyckel: nyckel ?? (lank && minaScenarion().find((x) => x.lank === lank)?.nyckel) ?? crypto.randomUUID(), lank: lank ?? null,
  };
  sparaLokalt();
  if (visa) visaScenario();
}

const hamtaLank = (hash) => (hash.startsWith('#s=') ? api(`/api/scenario/${encodeURIComponent(hash.slice(3))}`) : packaUpp(hash.slice(4)));
async function oppnaScenarioLank(hash) {
  if (scenario?.lank === kortLank(hash)) return visaScenario();
  try {
    await oppnaScenario(await hamtaLank(hash), { lank: kortLank(hash) });
  } catch (e) {
    showPanel(`<p class="empty">Kunde inte öppna scenariot: ${esc(e.message)}</p>`);
  }
}

async function nyttScenarioFran(namn, bet) {
  const s = await statusP;
  if (bet.length > s.maxScenario) {
    return showPanel(`<h2>För många fastigheter</h2><p class="empty">Ett scenario kan ha högst ${s.maxScenario.toLocaleString('sv-SE')}
      fastigheter, och urvalet har ${bet.length.toLocaleString('sv-SE')}. Avgränsa med filtret eller kartutsnittet.</p>`);
  }
  return oppnaScenario(nyttScenario(namn, bet));   // det öppna ligger kvar i Mina scenarion
}

// Sifferfält bundet till en plats i scenariot (vag), med det som används när fältet är tomt som platshållare.
// Textfält, inte type="number": Safari och Firefox ger ett tomt värde för "4,5" i ett sifferfält.
const talFalt = (vag, varde, platshallare, etikett) => `<input inputmode="decimal"
  data-k="${esc(JSON.stringify(vag))}" value="${esc(String(varde ?? '').replace('.', ','))}" placeholder="${esc(platshallare ?? '')}"${etikett ? ` aria-label="${esc(etikett)}"` : ''}>`;
const andel = (x) => (x == null || !Number.isFinite(x) ? '–' : `${(x * 100 + 0).toLocaleString('sv-SE', { maximumFractionDigits: 1 })} %`);
const heltal = (x) => Math.round(x).toLocaleString('sv-SE');
// Belopp i tkr; exakt noll visas som streck, som i en kalkyl på papper.
const tkrCell = (v, extra = '') => `<td class="num${extra}">${v === 0 ? '–' : heltal(v / 1000)}</td>`;

// Scenariovyn, uppifrån: namn och omfattning, knapparna, resultatet (nyckeltal och kassaflöde), antagandena
// och fastigheterna. Bara resultatet ritas om när ett fält ändras (se uppdateraResultat).
async function visaScenario() {
  const s = await statusP, sc = scenario, d = sc.data, slag = lokalslag(s);
  select(null);
  history.replaceState(null, '', `${location.pathname}${location.search}${sc.lank ? new URL(sc.lank).hash : '#scenario'}`);
  // Antagandena och fastighetslistan gäller scenariots egna fastigheter; delscenarierna har sina egna (se portföljen).
  const egnaBet = new Set(d.bet), u = sc.underlag.filter((f) => egnaBet.has(f.beteckning)), g = d.gemensamt;
  const ytaPerSlag = Object.fromEntries(slag.map((x) => [x, 0]));
  for (const f of u) for (const [x, m2] of Object.entries(ytor(f, d.egna[f.beteckning]))) ytaPerSlag[x] = (ytaPerSlag[x] ?? 0) + (Number(m2) || 0);
  const alla = sc.underlag;
  const ram = alla.length && [Math.min(...alla.map((f) => f.minx)), Math.min(...alla.map((f) => f.miny)),
    Math.max(...alla.map((f) => f.maxx)), Math.max(...alla.map((f) => f.maxy))].join(',');
  const andra = minaScenarion().filter((x) => x.nyckel !== sc.nyckel);
  // Lokalslag med yta (eller egna antaganden) visas direkt, övriga under "Fler lokalslag".
  const anvands = (x) => ytaPerSlag[x] > 0 || Object.keys(d.antaganden[x] ?? {}).length > 0;
  // data-rubrik: fältets rubrik när tabellen visas som kort på mobil (style.css).
  const slagRad = (x) => `<tr><th scope="row">${esc(x)}</th><td class="num sc-yta">${heltal(ytaPerSlag[x])}</td>
    ${ANTAGANDEN.map(([k, rubrik, ph]) => `<td data-rubrik="${esc(rubrik)}">${talFalt(['antaganden', x, k], d.antaganden[x]?.[k], ph, `${x}: ${rubrik}`)}</td>`).join('')}</tr>`;
  const slagTabell = (lista) => `<div class="sc-tabell"><table class="sc-antaganden">
    <tr><th>Lokalslag</th><th class="num">Yta, m²</th>${ANTAGANDEN.map(([, rubrik]) => `<th class="num">${rubrik}</th>`).join('')}</tr>
    ${lista.map(slagRad).join('')}</table></div>`;
  const ovriga = slag.filter((x) => !anvands(x));
  showPanel(`<div class="scenario">
    <input class="sc-namn" data-k='["namn"]' value="${esc(d.namn)}" maxlength="100" aria-label="Scenariots namn" placeholder="Namnlöst scenario">
    <div class="meta"><i class="sc-farg" style="background:var(${fargPa(sc.nyckel)})" title="Färgen på kartan"></i><span id="sc-omfattning"></span>${sc.byggd ? ` · underlag ${esc(sc.byggd.slice(0, 10))}` : ''}${ram
      ? ` · <a data-ram="${ram}">Visa på kartan</a>` : ''}</div>
    ${d.underlagFran && sc.byggd && d.underlagFran !== sc.byggd ? `<p class="notice small">Horos data har uppdaterats sedan scenariot sparades
      (${esc(d.underlagFran.slice(0, 10))}). Ytor och taxering är hämtade på nytt; dina egna värden är kvar.</p>` : ''}
    <div class="knappar">
      <button type="button" class="copy primar" data-sc="spara">Spara och kopiera länk</button>
      <button type="button" class="copy" data-sc="csv">Excel (CSV)</button>
      <button type="button" class="copy" data-sc="fil">Scenariofil</button>
      <button type="button" class="copy" data-sc="lista">Mina scenarion</button>
      <button type="button" class="copy" data-sc="stang">Stäng</button>
    </div>
    <p id="sc-varning" class="notice small"${sparatLokalt ? ' hidden' : ''}>Scenariot kunde inte sparas i webbläsaren (lagringen är full eller
      avstängd). Ladda ner scenariofilen eller spara en länk, annars försvinner det när sidan laddas om.</p>
    <input id="sc-lank" class="sc-lank" readonly aria-label="Länk till scenariot" value="${esc(sc.lank ?? '')}"${sc.lank ? '' : ' hidden'}>
    <div id="sc-resultat"></div>

    <h3>Kombinera med andra scenarier</h3>
    ${andra.length ? `<div class="sc-kombinera">
      <select id="sc-andra" aria-label="Scenario att kombinera med">${andra.map((x) => `<option value="${esc(x.nyckel)}">${esc(x.namn || 'Namnlöst scenario')}</option>`).join('')}</select>
      <button type="button" class="copy" data-sc="addera">Addera</button>
      <button type="button" class="copy" data-sc="subtrahera">Subtrahera</button>
    </div>
    <div class="meta small"><strong>Addera</strong> lägger in scenariot som ett delscenario med sina egna antaganden; portföljen
      summerar fastigheter, yta, taxeringsvärde, kassaflöde och värde. <strong>Subtrahera</strong> tar bort dess fastigheter härifrån.
      En fastighet räknas en gång, i första hand med det här scenariots antaganden.</div>`
    : '<div class="meta small">Skapa fler scenarier för att addera eller subtrahera dem med det här.</div>'}

    <h3>Antaganden</h3>
    <div class="meta small">Horos har inga marknadshyror, vakanser, driftkostnader eller avkastningskrav: värdet bygger
      helt på det du fyller i. Tomma fält räknas med värdet i grått.</div>
    <div class="sc-grid">
      <label>Startår${talFalt(['start'], d.start)}</label>
      <label>Kalkylperiod, år${talFalt(['ar'], d.ar)}</label>
      <label>Direktavkastningskrav, %${talFalt(['gemensamt', 'direktavk'], g.direktavk, 't.ex. 4,5')}</label>
      <label>Hyresutveckling, %/år${talFalt(['gemensamt', 'hyresutv'], g.hyresutv, '0')}</label>
      <label>Kostnadsutveckling, %/år${talFalt(['gemensamt', 'kostutv'], g.kostutv, '0')}</label>
      <label>Kalkylränta, %${talFalt(['gemensamt', 'kalkylranta'], g.kalkylranta, '')}</label>
    </div>
    ${slagTabell(slag.filter(anvands))}
    ${ovriga.length ? `<details class="sc-fler"><summary>Fler lokalslag (${ovriga.length})</summary>${slagTabell(ovriga)}</details>` : ''}

    <h3>Fastigheter</h3>
    <div class="meta small">Ytan är Horos uppskattning från företagen på fastigheten. Öppna en fastighet för att ange egna
      ytor, fastighetsskatt och tomträttsavgäld.</div>
    ${u.length ? '<div class="sc-rad sc-rubrik"><span>Fastighet</span><span class="num">Yta, m²</span><span class="num">Värde</span></div>' : ''}
    ${u.map((f) => { const e = d.egna[f.beteckning] ?? {}, bet = esc(f.beteckning);
      return `<details class="sc-fastighet"><summary class="sc-rad"><span>${bet}${demoTag(f.demo)}</span>
          <span class="num" data-yta="${bet}"></span><span class="num" data-varde="${bet}"></span></summary>
        <div class="meta small">${fastighetLink(f)} · ${esc(f.typ ?? 'taxering saknas')} · taxeringsvärde ${mkr(f.varde_tkr)}</div>
        <div class="sc-grid">
          ${slag.map((x) => `<label>${esc(x)}, m²${talFalt(['egna', f.beteckning, 'yta', x], e.yta?.[x], f.loa[x] ? heltal(f.loa[x]) : '0')}</label>`).join('')}
          <label>Fastighetsskatt, kr/år${talFalt(['egna', f.beteckning, 'skatt'], e.skatt, heltal(standardSkatt(f)))}</label>
          <label>Tomträttsavgäld, kr/år${talFalt(['egna', f.beteckning, 'avgald'], e.avgald, f.upplatelse === 'tomtratt' ? 'tomträtt: ange' : '0')}</label>
        </div>
        <button type="button" class="copy" data-sc="ta-bort" data-bet="${bet}">Ta bort ur scenariot</button>
      </details>`; }).join('')}
    ${sc.saknas.length ? `<p class="meta small">Finns inte längre i Horos: ${esc(sc.saknas.join(', '))}</p>` : ''}
    ${!alla.length ? '<p class="empty">Inga fastigheter ännu. Öppna en fastighet och välj <strong>Lägg till i scenariot</strong>.</p>' : ''}
    <p class="meta small">Länken visar scenariot som det var när du sparade; ändrar du något blir det en ny länk.
      Mina scenarion finns bara i den här webbläsaren.</p>
  </div>`);
  uppdateraResultat();
}

// Räknar om och visar nyckeltal, kassaflöde och värdet per fastighet (formuläret ritas inte om, så fokus stannar).
function uppdateraResultat() {
  const d = scenario.data, k = beraknaPortfolj(d, scenario.underlag), t = nyckeltal(k), sista = d.ar;
  const rest = (i) => (i === sista ? ' rest' : '');
  const antal = k.delar.reduce((a, x) => a + x.antal, 0);
  // Portföljen: en rad per del (det här scenariot först) och summan, när scenariot har delscenarier.
  const portfolj = k.delar.length > 1 ? `<h3>Portfölj</h3>
  <div class="sc-tabell"><table class="sc-portfolj">
    <tr><th>Del</th><th class="num">Fastigheter</th><th class="num">Yta, m²</th><th class="num">Taxeringsvärde</th><th class="num">Värde</th></tr>
    ${k.delar.map((x, i) => `<tr><th scope="row">${esc(x.namn || 'Namnlöst scenario')}${i ? ` <a class="small" data-sc="ta-bort-del" data-i="${i - 1}">Ta bort</a>` : ' <span class="muted small">(egna)</span>'}</th>
      <td class="num">${heltal(x.antal)}</td><td class="num">${heltal(x.yta)}</td><td class="num">${mkr(x.taxering_tkr)}</td>
      <td class="num">${x.k.varde == null ? '–' : mkr(x.k.varde / 1000)}</td></tr>`).join('')}
    <tr class="summa"><th scope="row">Summa</th><td class="num">${heltal(antal)}</td><td class="num">${heltal(k.yta)}</td>
      <td class="num">${mkr(k.delar.reduce((a, x) => a + x.taxering_tkr, 0))}</td><td class="num">${k.varde == null ? '–' : mkr(k.varde / 1000)}</td></tr>
  </table></div>` : '';
  $('#sc-resultat').innerHTML = `${stats([
    ['Värde', k.varde == null ? '–' : mkr(k.varde / 1000), k.varde == null ? 'Ange direktavkastningskrav' : `Kalkylränta ${andel(k.kalkylranta)}`],
    ['Värde per m²', k.varde == null || !k.yta ? '–' : kr(k.varde / k.yta)],
    ['Driftnetto år 1', mkr(k.total.dn[0] / 1000)],
    ['Direktavkastning år 1', andel(t.direktavkastning)],
    ['Vakanstålighet', andel(t.vakanstalighet), `Vakans år 1: ${andel(t.vakans)}`],
    ['DoU-tålighet', andel(t.doutalighet)],
  ])}
  ${portfolj}
  <h3>Kassaflöde, tkr</h3>
  <div class="sc-tabell"><table class="sc-kassaflode">
    <tr><th></th>${k.ar.map((a, i) => `<th class="num${rest(i)}">${a}${i === sista ? '*' : ''}</th>`).join('')}</tr>
    ${KALKYL_RADER.map(([key, rubrik, summa]) => `<tr${summa ? ' class="summa"' : ''}><th scope="row">${rubrik}</th>${k.total[key]
      .map((v, i) => tkrCell(v, rest(i))).join('')}</tr>`).join('')}
  </table></div>
  <div class="meta small">* Året efter kalkylperioden. Restvärdet är dess driftnetto delat med direktavkastningskravet.
    Kalkylränta ${andel(k.kalkylranta)}${d.gemensamt.kalkylranta == null ? ' (direktavkastningskrav plus hyresutveckling)' : ''}.
    Tåligheterna gäller år 1, utan lån.</div>`;
  $('#sc-omfattning').textContent = `${heltal(antal)} ${antal === 1 ? 'fastighet' : 'fastigheter'} · ${heltal(k.yta)} m²${k.delar.length > 1
    ? ` · ${k.delar.length - 1} ${k.delar.length === 2 ? 'delscenario' : 'delscenarier'}` : ''}`;
  const ranta = document.querySelector('[data-k=\'["gemensamt","kalkylranta"]\']');
  if (ranta) ranta.placeholder = (k.kalkylranta * 100).toLocaleString('sv-SE', { maximumFractionDigits: 2 });
  const perBet = new Map(k.per.map((p) => [p.beteckning, p]));
  for (const el of document.querySelectorAll('[data-varde]')) {
    const p = perBet.get(el.dataset.varde);
    el.textContent = p?.varde == null ? '–' : mkr(p.varde / 1000);
  }
  for (const el of document.querySelectorAll('[data-yta]')) el.textContent = heltal(perBet.get(el.dataset.yta)?.yta ?? 0);
}

// Ett fält i scenariot ändrades (se talFalt).
function scenarioInput(el) {
  const vag = JSON.parse(el.dataset.k), d = scenario.data;
  const tal = el.value.replace(/\s/g, '').replace(',', '.');   // "1 000,5" som besökaren skriver det
  const v = el.inputMode === 'decimal' ? (tal === '' || !Number.isFinite(+tal) ? undefined : +tal) : el.value.slice(0, 100);
  let o = d;
  for (const k of vag.slice(0, -1)) o = o[k] ??= {};
  if (v === undefined) delete o[vag.at(-1)]; else o[vag.at(-1)] = v;
  d.ar = Math.min(10, Math.max(1, Math.round(d.ar) || 5));
  d.start = Math.round(d.start) || new Date().getFullYear();
  andrat();
  uppdateraResultat();
}
// Scenariot skiljer sig nu från den delade länken.
function andrat() {
  scenario.lank = null;
  sparaLokalt();
  if (!$('#panel .scenario')) return;   // ändrat från en annan vy (Lägg till): adressen är den vyns
  history.replaceState(null, '', `${location.pathname}${location.search}#scenario`);
  $('#sc-lank').hidden = true;
}

// Lägger till fastigheterna i det öppna scenariot (från fastighetspanelen, sökträffarna, filtret eller ett
// bolag). Returnerar antalet tillagda (de som redan finns med hoppas över), eller null om scenariot skulle bli
// större än maxScenario; det visas då i panelen.
async function laggTillIScenario(bet) {
  const s = await statusP, finns = new Set(allaBet(scenario.data));   // också delscenariernas
  const nya = [...new Set(bet.map(normBet))].filter((b) => !finns.has(b));
  if (finns.size + nya.length > s.maxScenario) {
    showPanel(`<h2>För många fastigheter</h2><p class="empty">Ett scenario kan ha högst ${s.maxScenario.toLocaleString('sv-SE')}
      fastigheter. ${esc(scenario.data.namn || 'Scenariot')} har ${finns.size.toLocaleString('sv-SE')} och du försökte lägga till
      ${nya.length.toLocaleString('sv-SE')}.</p>`);
    return null;
  }
  if (!nya.length) return 0;
  const r = await api('/api/underlag', { bet: nya });
  scenario.data.bet.push(...r.fastigheter.map((f) => f.beteckning));
  scenario.underlag.push(...r.fastigheter);
  andrat();
  return r.fastigheter.length;
}
async function sparaScenario(knapp) {
  const s = await statusP;
  const d = { ...scenario.data, underlagFran: scenario.byggd ?? undefined };
  let hash = null;
  if (s.kortlankar) hash = await api('/api/scenario', d).then((r) => `#s=${r.id}`, () => null);   // annars i länken
  hash ??= `#sd=${await packa(d)}`;
  scenario.data = d;
  scenario.lank = kortLank(hash);
  sparaLokalt();
  history.replaceState(null, '', `${location.pathname}${location.search}${hash}`);
  const falt = $('#sc-lank');
  Object.assign(falt, { value: scenario.lank, hidden: false });
  falt.select();
  navigator.clipboard.writeText(scenario.lank).then(() => { knapp.textContent = 'Sparat, länken är kopierad'; },
    () => { knapp.textContent = 'Sparat, kopiera länken nedan'; });
}

// Tabellen som CSV för Excel (BOM, semikolon och decimalkomma, som träff-exporten).
function scenarioCsv(s) {
  const d = scenario.data, k = beraknaPortfolj(d, scenario.underlag), g = d.gemensamt;
  // Text som börjar med = + - @ (t.ex. namnet från någon annans länk) blir annars en formel i Excel.
  const text = (v) => (/^[=+\-@]/.test(v) ? `'${v}` : v);
  const cell = (v) => (v == null ? '' : typeof v === 'number' ? String(Math.round(v * 100) / 100).replace('.', ',')
    : /[;"\n]/.test(v) ? `"${text(v).replace(/"/g, '""')}"` : text(v));
  const rader = [
    ['Scenario', d.namn], ['Startår', d.start], ['Kalkylperiod, år', d.ar], ['Hyresutveckling, %', g.hyresutv],
    ['Kostnadsutveckling, %', g.kostutv], ['Direktavkastningskrav, %', g.direktavk], ['Kalkylränta, %', k.kalkylranta * 100],
    ['Värde, kr', k.varde == null ? null : Math.round(k.varde)], ['Yta, m²', Math.round(k.yta)], [],
    ...(k.delar.length > 1 ? [['Del', 'Fastigheter', 'Yta, m²', 'Taxeringsvärde, kr', 'Värde, kr'],
      ...k.delar.map((x) => [x.namn, x.antal, Math.round(x.yta), x.taxering_tkr * 1000, x.k.varde == null ? null : Math.round(x.k.varde)]), []] : []),
    ['Lokalslag', ...ANTAGANDEN.map(([, rubrik]) => rubrik)],
    ...lokalslag(s).map((x) => [x, ...ANTAGANDEN.map(([key]) => d.antaganden[x]?.[key])]), [],
    ['Kassaflöde, kr', ...k.ar], ...KALKYL_RADER.map(([key, rubrik]) => [rubrik, ...k.total[key].map(Math.round)]), [],
    ['Fastighet', 'Yta, m²', 'Driftnetto år 1, kr', 'Värde, kr'],
    ...k.per.map((p) => [p.beteckning, Math.round(p.yta), Math.round(p.rader.dn[0]), p.varde == null ? null : Math.round(p.varde)]),
    [], ['Källa: Horos (horos.se). Värdet bygger på användarens antaganden.'],
  ];
  return `﻿${rader.map((r) => r.map(cell).join(';')).join('\r\n')}`;
}

function laddaNer(filnamn, text, typ) {
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(new Blob([text], { type: typ })), download: filnamn });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
const filnamn = () => `horos-scenario-${(scenario.data.namn || 'namnlost').toLowerCase().replace(/[^a-z0-9åäö]+/g, '-').replace(/^-|-$/g, '')}`;

async function lasScenarioFil(fil) {
  try { await oppnaScenario(JSON.parse(await fil.text())); }
  catch { showPanel('<p class="empty">Filen kunde inte läsas som ett scenario från Horos.</p>'); }
}

// Mina scenarion, eller det öppna scenariot (också efter en omladdning).
async function openScenarier({ lista = false } = {}) {
  if (!lista && scenario) return visaScenario();
  const mina = minaScenarion();
  const aktivt = !lista && mina.find((x) => x.nyckel === store.get('horos.aktivt'));
  if (aktivt) return oppnaPost(aktivt);
  select(null);
  showPanel(`
    <h2>Scenarier</h2>
    <div class="meta">Egna kassaflödeskalkyler för en eller flera fastigheter</div>
    <p class="small">Starta från en fastighet (<strong>+</strong> uppe till höger), ett bolag (<strong>Räkna på innehavet</strong>)
      eller filtret (<strong>Räkna på träffarna</strong>). Fyll i hyror, vakanser, kostnader och avkastningskrav, så räknar Horos
      fram kassaflöde och värde år för år. Allt sparas här i webbläsaren; <strong>Spara och kopiera länk</strong> ger en länk att dela.</p>
    <h3>Mina scenarion</h3>
    ${table('<th>Karta</th><th>Scenario</th><th class="num">Senast använt</th><th></th>', mina.map((x) =>
      `<tr><td class="sc-karta"><label><input type="checkbox" data-synlig="${esc(x.nyckel)}"${paKartan().includes(x.nyckel) ? ' checked' : ''}${x.nyckel === scenario?.nyckel
        ? ' disabled title="Det öppna scenariot syns alltid"' : ''} aria-label="Visa ${esc(x.namn || 'scenariot')} på kartan"><i class="sc-farg"
        style="background:var(${fargPa(x.nyckel)})"${paKartan().includes(x.nyckel) ? '' : ' hidden'}></i></label></td>
        <td><a data-sc="oppna" data-nyckel="${esc(x.nyckel)}">${esc(x.namn || 'Namnlöst scenario')}</a>${x.nyckel === scenario?.nyckel ? ' <span class="tag">öppet</span>' : ''}
        <div class="muted small">${Number(x.antal).toLocaleString('sv-SE')} fastigheter · ${x.lank ? 'delad länk' : 'inte delat'}</div></td>
        <td class="num">${esc(x.andrad ?? x.sparad ?? '')}</td><td class="num"><a data-sc="glom" data-nyckel="${esc(x.nyckel)}">Ta bort</a></td></tr>`),
      'Inga scenarier i den här webbläsaren ännu.')}
    <div class="meta small">Bocka i <strong>Karta</strong> för att se scenariots fastigheter på kartan i dess färg; vitt betyder
      att fastigheten finns i flera. Det öppna scenariot syns alltid.</div>
    <div class="meta small">Listan finns bara i den här webbläsaren. Att ta bort ett scenario här tar inte bort en delad länk.
      Ladda ner scenariofilen om du vill ha en egen kopia eller flytta scenariot till en annan dator.</div>
    <label class="copy">Öppna scenariofil<input type="file" accept=".json,application/json" data-sc-fil hidden></label>
  `);
}

// Addera: det andra scenariot (och dess delscenarier) blir delscenarier här; finns det redan som del ersätts det.
// Subtrahera: dess fastigheter tas bort härifrån, ur de egna och ur delscenarierna (tomma delar försvinner).
async function kombinera(satt, nyckel, knapp) {
  const s = await statusP, d = scenario.data, x = minaScenarion().find((m) => m.nyckel === nyckel);
  if (!x || x.nyckel === scenario.nyckel) return;
  let b;
  try { b = x.data ?? await hamtaLank(new URL(x.lank).hash); } catch { knapp.textContent = 'Kunde inte hämtas'; return; }
  const delar = [delAv(b, x.nyckel), ...(Array.isArray(b.delar) ? b.delar : []).filter((y) => Array.isArray(y?.bet)).map((y) => delAv(y, y.nyckel))]
    .filter((y) => y.nyckel !== scenario.nyckel);   // inte det här scenariot i sig självt
  if (satt === 'subtrahera') {
    const bort = new Set(delar.flatMap((y) => y.bet));
    d.bet = d.bet.filter((bet) => !bort.has(bet));
    d.delar = d.delar.map((y) => ({ ...y, bet: y.bet.filter((bet) => !bort.has(bet)) })).filter((y) => y.bet.length);
  } else {
    const nycklar = new Set(delar.map((y) => y.nyckel).filter(Boolean));
    const nyaDelar = [...d.delar.filter((y) => !nycklar.has(y.nyckel)), ...delar];
    const alla = allaBet({ ...d, delar: nyaDelar });
    if (alla.length > s.maxScenario) {
      return showPanel(`<h2>För många fastigheter</h2><p class="empty">Ett scenario kan ha högst ${s.maxScenario.toLocaleString('sv-SE')}
        fastigheter, och portföljen skulle få ${alla.length.toLocaleString('sv-SE')}.</p>`);
    }
    const finns = new Set(scenario.underlag.map((f) => f.beteckning)), saknas = alla.filter((bet) => !finns.has(bet));
    try { if (saknas.length) scenario.underlag.push(...(await api('/api/underlag', { bet: saknas })).fastigheter); }
    catch { knapp.textContent = 'Kunde inte hämtas'; return; }
    d.delar = nyaDelar;
  }
  andrat();
  return visaScenario();
}

// Knappar med data-sc i panelen och i +-menyn.
async function scenarioKlick(el) {
  const s = await statusP, a = el.dataset.sc;
  if (a === 'bolag' && bolagUrval) {
    if (!scenario) return nyttScenarioFran(bolagUrval.namn, bolagUrval.bet);
    if ((await laggTillIScenario(bolagUrval.bet)) !== null) visaScenario();
    return;
  }
  if (a === 'fastighet') return nyttScenarioFran(el.dataset.bet, [el.dataset.bet]);
  if (a === 'visa') return visaScenario();
  if (a === 'lista') return openScenarier({ lista: true });
  if (a === 'ta-bort') {
    const bet = el.dataset.bet;
    scenario.data.bet = scenario.data.bet.filter((b) => b !== bet);
    scenario.underlag = scenario.underlag.filter((f) => f.beteckning !== bet);
    delete scenario.data.egna[bet];
    andrat();
    return visaScenario();
  }
  if (a === 'addera' || a === 'subtrahera') return kombinera(a, $('#sc-andra').value, el);
  if (a === 'ta-bort-del') {
    scenario.data.delar.splice(Number(el.dataset.i), 1);
    andrat();
    return visaScenario();
  }
  if (a === 'spara') return sparaScenario(el);
  if (a === 'csv') return laddaNer(`${filnamn()}.csv`, scenarioCsv(s), 'text/csv;charset=utf-8');
  if (a === 'fil') return laddaNer(`${filnamn()}.json`, JSON.stringify(scenario.data, null, 1), 'application/json');
  if (a === 'stang') {   // scenariot ligger kvar i Mina scenarion men inget är öppet; på kartan bara om det är ibockat
    scenario = null;
    sparaLokalt();
    ritaScenarier();
    return openScenarier({ lista: true });
  }
  const mina = minaScenarion(), x = mina.find((m) => m.nyckel === el.dataset.nyckel);
  if (a === 'oppna' && x) return oppnaPost(x);
  if (a === 'glom') {
    sparaMina(mina.filter((m) => m !== x));
    sattSynliga(synliga().filter((n) => n !== x?.nyckel));
    if (x && x.nyckel === scenario?.nyckel) { scenario = null; sparaLokalt(); }
    ritaScenarier();
    return openScenarier({ lista: true });
  }
  // +-menyn i fastighetspanelen: lägg till i valt scenario, som då blir det öppna.
  if (a === 'lagg-i' && x) {
    el.disabled = true;
    if (x.nyckel !== scenario?.nyckel) {
      try { await oppnaPost(x, { visa: false }); } catch { /* visas inte; kontrolleras nedan */ }
      if (scenario?.nyckel !== x.nyckel) { el.textContent = 'Kunde inte öppnas, försök igen'; el.disabled = false; return; }   // annars hamnar fastigheten i fel scenario
    }
    if ((await laggTillIScenario([el.dataset.bet]).catch(() => null)) === null) return;
    // Rita om menyn (bock och vilket som är öppet) och låt den stå öppen.
    const ny = document.createRange().createContextualFragment(scenarioMeny(el.dataset.bet)).firstElementChild;
    ny.open = true;
    el.closest('.sc-meny').replaceWith(ny);
  }
}

// +-menyn i fastighetspanelen: scenarierna (det öppna först, bock där fastigheten redan finns) och Nytt scenario.
function scenarioMeny(bet) {
  const mina = minaScenarion().sort((a, b) => (b.nyckel === scenario?.nyckel) - (a.nyckel === scenario?.nyckel));
  const med = (x) => allaBet(x.nyckel === scenario?.nyckel ? scenario.data : x.data ?? { bet: [] }).includes(bet);
  const namn = (x) => `${esc(x.namn || 'Namnlöst scenario')}${x.nyckel === scenario?.nyckel ? ' <span class="muted small">öppet</span>' : ''}`;
  return `<details class="sc-meny"><summary class="lagg-till" title="Lägg till i ett scenario" aria-label="Lägg till ${esc(bet)} i ett scenario">+</summary>
    <div class="sc-meny-lista">
      <div class="sc-meny-rubrik">Lägg till i scenario</div>
      ${mina.map((x) => (med(x)
        ? `<button type="button" class="klar" data-sc="oppna" data-nyckel="${esc(x.nyckel)}">✓ ${namn(x)}</button>`
        : `<button type="button" data-sc="lagg-i" data-nyckel="${esc(x.nyckel)}" data-bet="${esc(bet)}">${namn(x)}</button>`)).join('')}
      <button type="button" class="ny" data-sc="fastighet" data-bet="${esc(bet)}">Nytt scenario</button>
    </div></details>`;
}
// Bolagspanelen: hela innehavet till ett nytt scenario, eller till det öppna.
const scenarioNamn = () => esc(scenario.data.namn || 'scenariot');
const bolagScenarioKnapp = () => `<button type="button" class="copy" data-sc="bolag">${scenario ? `Lägg till i ${scenarioNamn()}` : 'Räkna på innehavet'}</button>`;
// Plusknappen på sökträffar med en fastighet när ett scenario är öppet (se runSearch).
const sokLaggTill = (bet) => (!scenario || !bet ? ''
  : allaBet(scenario.data).includes(bet) ? ` <button type="button" class="lagg-till" disabled title="Finns i ${scenarioNamn()}">✓</button>`
    : ` <button type="button" class="lagg-till" data-lagg="${esc(bet)}" title="Lägg till i ${scenarioNamn()}"
      aria-label="Lägg till ${esc(bet)} i ${scenarioNamn()}">+</button>`);
