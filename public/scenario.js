// Scenarier: egna kassaflödeskalkyler för en grupp fastigheter (som Datschas "Scenarion"), utan inloggning.
// Ett scenario sparas som kort länk (/api/scenario; id:t är en hash av innehållet, så en delad länk ändras
// aldrig), eller i själva länken (#sd=) om servern inte kan spara. Listan Mina scenarion och utkastet ligger
// i webbläsaren, och scenariot kan laddas ner och öppnas som fil. Bara deklarationer; app.js kopplar in dem.

let scenario = null;     // öppet scenario: { data, underlag, saknas, byggd, nyckel, lank }
let bolagUrval = null;   // senast öppnade bolagets fastigheter, för "Räkna på innehavet" (se openBolag)

const nyttScenario = (namn, bet) => ({ v: 1, namn: String(namn).slice(0, 100), start: new Date().getFullYear(), ar: 5,
  bet: [...new Set(bet)], gemensamt: { hyresutv: 2, kostutv: 2 }, antaganden: {}, egna: {} });
const lokalslag = (s) => ['Bostäder', ...s.lokaltyper];
const ANTAGANDEN = [['hyra', 'Hyra, kr/m²', 't.ex. 2 000'], ['vakans', 'Vakans, %', '0'], ['drift', 'Drift, kr/m²', '0'], ['uh', 'Underhåll, kr/m²', '0']];
const normBet = (b) => String(b).trim().replace(/\s+/g, ' ').toUpperCase();   // som normBeteckning på servern

// Mina scenarion och utkastet (det öppna scenariot, så att det finns kvar efter en omladdning).
const minaScenarion = () => { try { return JSON.parse(store.get('horos.scenarion')) ?? []; } catch { return []; } };
const sparaMina = (l) => store.set('horos.scenarion', JSON.stringify(l.slice(0, 50)));
const utkast = () => { try { return JSON.parse(store.get('horos.utkast')); } catch { return null; } };
const sparaUtkast = () => store.set('horos.utkast', scenario
  ? JSON.stringify({ data: scenario.data, nyckel: scenario.nyckel, lank: scenario.lank }) : '');

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

// Öppnar scenariot (data i formatet från nyttScenario, t.ex. från en länk eller fil) med underlaget från servern.
async function oppnaScenario(data, { nyckel, lank } = {}) {
  if (data?.v !== 1 || !Array.isArray(data.bet)) return showPanel('<p class="empty">Det här är inte ett scenario från Horos.</p>');
  const s = await statusP;
  // Länkar och filer kommer utifrån: fyll i det som saknas och håll år och period inom rimliga gränser.
  const d = { ...nyttScenario('', []), ...data };
  d.bet = [...new Set(d.bet.filter((b) => typeof b === 'string').map(normBet))].slice(0, s.maxScenario);
  d.ar = Math.min(10, Math.max(1, Math.round(d.ar) || 5));
  d.start = Math.min(2100, Math.max(1900, Math.round(d.start) || new Date().getFullYear()));
  for (const k of ['gemensamt', 'antaganden', 'egna']) if (typeof d[k] !== 'object' || !d[k]) d[k] = {};
  let u;
  try { u = await api('/api/underlag', { bet: d.bet }); } catch (e) { return showPanel(`<p class="empty">${esc(e.message)}</p>`); }
  const finns = new Set(u.fastigheter.map((f) => f.beteckning));
  scenario = {
    data: d, underlag: u.fastigheter.sort((a, b) => (b.varde_tkr ?? 0) - (a.varde_tkr ?? 0)),
    saknas: d.bet.filter((b) => !finns.has(b)), byggd: u.byggd,
    nyckel: nyckel ?? minaScenarion().find((x) => x.lank === lank)?.nyckel ?? crypto.randomUUID(), lank: lank ?? null,
  };
  sparaUtkast();
  visaScenario();
}

async function oppnaScenarioLank(hash) {
  if (scenario?.lank === kortLank(hash)) return visaScenario();
  try {
    const data = hash.startsWith('#s=') ? await api(`/api/scenario/${encodeURIComponent(hash.slice(3))}`) : await packaUpp(hash.slice(4));
    await oppnaScenario(data, { lank: kortLank(hash) });
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
  if (scenario && !scenario.lank && !confirm(`Scenariot "${scenario.data.namn}" är inte sparat. Vill du ersätta det?`)) return;
  return oppnaScenario(nyttScenario(namn, bet));
}

// Sifferfält bundet till en plats i scenariot (vag), med det som används när fältet är tomt som platshållare.
const talFalt = (vag, varde, platshallare, etikett) => `<input type="number" step="any" inputmode="decimal"
  data-k="${esc(JSON.stringify(vag))}" value="${varde ?? ''}" placeholder="${esc(platshallare ?? '')}"${etikett ? ` aria-label="${esc(etikett)}"` : ''}>`;
const andel = (x) => (x == null || !Number.isFinite(x) ? '–' : `${(x * 100).toLocaleString('sv-SE', { maximumFractionDigits: 1 })} %`);
const tkrCell = (v) => `<td class="num">${Math.round(v / 1000).toLocaleString('sv-SE')}</td>`;

async function visaScenario() {
  const s = await statusP, sc = scenario, d = sc.data, slag = lokalslag(s);
  select(null);
  history.replaceState(null, '', `${location.pathname}${location.search}${sc.lank ? new URL(sc.lank).hash : '#scenario'}`);
  const ytaPerSlag = Object.fromEntries(slag.map((x) => [x, 0]));
  for (const f of sc.underlag) for (const [x, m2] of Object.entries(ytor(f, d.egna[f.beteckning]))) ytaPerSlag[x] = (ytaPerSlag[x] ?? 0) + (Number(m2) || 0);
  const u = sc.underlag;
  const ram = u.length && [Math.min(...u.map((f) => f.minx)), Math.min(...u.map((f) => f.miny)),
    Math.max(...u.map((f) => f.maxx)), Math.max(...u.map((f) => f.maxy))].join(',');
  const g = d.gemensamt;
  showPanel(`<div class="scenario">
    <h2><input class="sc-namn" data-k='["namn"]' value="${esc(d.namn)}" maxlength="100" aria-label="Scenariots namn" placeholder="Namnlöst scenario"></h2>
    <div class="meta">${u.length.toLocaleString('sv-SE')} ${u.length === 1 ? 'fastighet' : 'fastigheter'}${sc.byggd ? ` · underlag från ${esc(sc.byggd.slice(0, 10))}` : ''}${ram
      ? ` · <a data-ram="${ram}" data-markera="${esc(JSON.stringify(u.map((f) => f.beteckning)))}">Visa på kartan</a>` : ''}</div>
    ${d.underlagFran && sc.byggd && d.underlagFran !== sc.byggd ? `<p class="notice small">Horos data har uppdaterats sedan scenariot sparades
      (${esc(d.underlagFran.slice(0, 10))}). Ytor och taxering är hämtade på nytt; dina egna värden är kvar.</p>` : ''}
    <p class="meta small">Värdet bygger helt på dina antaganden. Horos har inga marknadshyror, vakanser, driftkostnader eller
      avkastningskrav: fyll i dem nedan. Ytan är Horos uppskattning från företagen på fastigheten, eller din egen.</p>
    <div id="sc-resultat"></div>
    <h3>Antaganden</h3>
    <div class="sc-grid">
      <label>Startår${talFalt(['start'], d.start)}</label>
      <label>Kalkylperiod, år${talFalt(['ar'], d.ar)}</label>
      <label>Hyresutveckling, %/år${talFalt(['gemensamt', 'hyresutv'], g.hyresutv, '0')}</label>
      <label>Kostnadsutveckling, %/år${talFalt(['gemensamt', 'kostutv'], g.kostutv, '0')}</label>
      <label>Direktavkastningskrav, %${talFalt(['gemensamt', 'direktavk'], g.direktavk, 't.ex. 4,5')}</label>
      <label>Kalkylränta, %${talFalt(['gemensamt', 'kalkylranta'], g.kalkylranta, '')}</label>
    </div>
    <div class="sc-tabell"><table>
      <tr><th>Lokalslag</th><th class="num">Yta, m²</th>${ANTAGANDEN.map(([, rubrik]) => `<th>${rubrik}</th>`).join('')}</tr>
      ${slag.map((x) => `<tr><td>${esc(x)}</td><td class="num">${Math.round(ytaPerSlag[x]).toLocaleString('sv-SE')}</td>
        ${ANTAGANDEN.map(([k, rubrik, ph]) => `<td>${talFalt(['antaganden', x, k], d.antaganden[x]?.[k], ph, `${x}: ${rubrik}`)}</td>`).join('')}</tr>`).join('')}
    </table></div>
    <h3>Fastigheter</h3>
    <div class="meta small">Klicka på en fastighet för att ändra ytor, fastighetsskatt och tomträttsavgäld. Tomma fält använder värdet i grått.</div>
    ${u.map((f) => { const e = d.egna[f.beteckning] ?? {};
      return `<details class="sc-fastighet"><summary><span>${esc(f.beteckning)}${demoTag(f.demo)}</span><span class="num" data-varde="${esc(f.beteckning)}"></span></summary>
        <div class="sc-grid">
          ${slag.map((x) => `<label>${esc(x)}, m²${talFalt(['egna', f.beteckning, 'yta', x], e.yta?.[x], f.loa[x] ? Math.round(f.loa[x]) : '0')}</label>`).join('')}
          <label>Fastighetsskatt, kr/år${talFalt(['egna', f.beteckning, 'skatt'], e.skatt, standardSkatt(f))}</label>
          <label>Tomträttsavgäld, kr/år${talFalt(['egna', f.beteckning, 'avgald'], e.avgald, f.upplatelse === 'tomtratt' ? 'tomträtt: fyll i' : '0')}</label>
        </div>
        <p class="small">${fastighetLink(f)} · ${esc(f.typ ?? 'taxering saknas')} · taxeringsvärde ${mkr(f.varde_tkr)}
          · <a data-sc="ta-bort" data-bet="${esc(f.beteckning)}">Ta bort ur scenariot</a></p>
      </details>`; }).join('')}
    ${sc.saknas.length ? `<p class="meta small">Finns inte längre i Horos: ${esc(sc.saknas.join(', '))}</p>` : ''}
    ${!u.length ? '<p class="empty">Inga fastigheter ännu. Öppna en fastighet och välj <strong>Lägg till i scenariot</strong>.</p>' : ''}
    <h3>Spara och dela</h3>
    <div class="meta small">Länken visar scenariot som det var när du sparade; ändrar du något blir det en ny länk.
      Mina scenarion finns bara i den här webbläsaren.</div>
    <div class="sc-knappar">
      <button type="button" class="copy" data-sc="spara">Spara och kopiera länk</button>
      <button type="button" class="copy" data-sc="csv">Ladda ner tabell (CSV)</button>
      <button type="button" class="copy" data-sc="fil">Ladda ner scenariofil</button>
      <button type="button" class="copy" data-sc="lista">Mina scenarion</button>
      <button type="button" class="copy" data-sc="stang">Stäng scenariot</button>
    </div>
    <input id="sc-lank" class="sc-lank" readonly aria-label="Länk till scenariot" value="${esc(sc.lank ?? '')}"${sc.lank ? '' : ' hidden'}>
  </div>`);
  uppdateraResultat();
}

// Räknar om och visar nyckeltal, kassaflöde och värdet per fastighet (formuläret ritas inte om, så fokus stannar).
function uppdateraResultat() {
  const d = scenario.data, k = berakna(d, scenario.underlag), t = nyckeltal(k);
  $('#sc-resultat').innerHTML = `${stats([
    ['Värde', k.varde == null ? '–' : mkr(k.varde / 1000), k.varde == null ? 'Ange avkastningskrav' : k.yta ? `${kr(k.varde / k.yta)}/m²` : ''],
    ['Driftnetto år 1', mkr(k.total.dn[0] / 1000)],
    ['Direktavkastning år 1', andel(t.direktavkastning)],
    ['Yta', `${Math.round(k.yta).toLocaleString('sv-SE')} m²`],
    ['Vakanstålighet', andel(t.vakanstalighet), `Vakans nu ${andel(t.vakans)}`],
    ['DoU-tålighet', andel(t.doutalighet)],
  ])}
  <div class="sc-tabell"><table>
    <tr><th>tkr</th>${k.ar.map((a, i) => `<th class="num">${a}${i === d.ar ? '*' : ''}</th>`).join('')}</tr>
    ${KALKYL_RADER.map(([key, rubrik, summa]) => `<tr${summa ? ' class="anv-summa"' : ''}><td>${rubrik}</td>${k.total[key].map(tkrCell).join('')}</tr>`).join('')}
  </table></div>
  <div class="meta small">* Året efter kalkylperioden: restvärdet är dess driftnetto delat med direktavkastningskravet.
    Kalkylränta ${andel(k.kalkylranta)}${d.gemensamt.kalkylranta == null ? ' (direktavkastningskrav plus hyresutveckling)' : ''}.
    Tåligheterna gäller år 1 och utan lån.</div>`;
  const ranta = document.querySelector('[data-k=\'["gemensamt","kalkylranta"]\']');
  if (ranta) ranta.placeholder = (k.kalkylranta * 100).toLocaleString('sv-SE', { maximumFractionDigits: 2 });
  const perBet = new Map(k.per.map((p) => [p.beteckning, p]));
  for (const el of document.querySelectorAll('[data-varde]')) {
    const p = perBet.get(el.dataset.varde);
    el.textContent = p?.varde == null ? `${Math.round(p?.yta ?? 0).toLocaleString('sv-SE')} m²` : mkr(p.varde / 1000);
  }
}

// Ett fält i scenariot ändrades (se talFalt).
function scenarioInput(el) {
  const vag = JSON.parse(el.dataset.k), d = scenario.data;
  const v = el.type === 'number' ? (el.value === '' || !Number.isFinite(+el.value) ? undefined : +el.value) : el.value.slice(0, 100);
  let o = d;
  for (const k of vag.slice(0, -1)) o = o[k] ??= {};
  if (v === undefined) delete o[vag.at(-1)]; else o[vag.at(-1)] = v;
  d.ar = Math.min(10, Math.max(1, Math.round(d.ar) || 5));
  d.start = Math.round(d.start) || new Date().getFullYear();
  andrat();
  uppdateraResultat();
}
// Scenariot skiljer sig nu från den sparade länken.
function andrat() {
  scenario.lank = null;
  sparaUtkast();
  history.replaceState(null, '', `${location.pathname}${location.search}#scenario`);
  const lank = $('#sc-lank');
  if (lank) lank.hidden = true;
}

async function sparaScenario(knapp) {
  const s = await statusP;
  const d = { ...scenario.data, underlagFran: scenario.byggd ?? undefined };
  let hash = null;
  if (s.kortlankar) hash = await api('/api/scenario', d).then((r) => `#s=${r.id}`, () => null);   // annars i länken
  hash ??= `#sd=${await packa(d)}`;
  scenario.data = d;
  scenario.lank = kortLank(hash);
  sparaUtkast();
  history.replaceState(null, '', `${location.pathname}${location.search}${hash}`);
  sparaMina([{ nyckel: scenario.nyckel, namn: d.namn, lank: scenario.lank, sparad: new Date().toISOString().slice(0, 10), antal: d.bet.length },
    ...minaScenarion().filter((x) => x.nyckel !== scenario.nyckel)]);
  const falt = $('#sc-lank');
  Object.assign(falt, { value: scenario.lank, hidden: false });
  falt.select();
  navigator.clipboard.writeText(scenario.lank).then(() => { knapp.textContent = 'Sparat, länken är kopierad'; },
    () => { knapp.textContent = 'Sparat, kopiera länken nedan'; });
}

// Tabellen som CSV för Excel (BOM, semikolon och decimalkomma, som träff-exporten).
function scenarioCsv(s) {
  const d = scenario.data, k = berakna(d, scenario.underlag), g = d.gemensamt;
  const cell = (v) => (v == null ? '' : typeof v === 'number' ? String(Math.round(v * 100) / 100).replace('.', ',')
    : /[;"\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const rader = [
    ['Scenario', d.namn], ['Startår', d.start], ['Kalkylperiod, år', d.ar], ['Hyresutveckling, %', g.hyresutv],
    ['Kostnadsutveckling, %', g.kostutv], ['Direktavkastningskrav, %', g.direktavk], ['Kalkylränta, %', k.kalkylranta * 100],
    ['Värde, kr', k.varde == null ? null : Math.round(k.varde)], ['Yta, m²', Math.round(k.yta)], [],
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

// Mina scenarion, eller det öppna scenariot (också efter en omladdning, från utkastet).
async function openScenarier({ lista = false } = {}) {
  if (!lista && scenario) return visaScenario();
  const u = !lista && utkast();
  if (u?.data) return oppnaScenario(u.data, u);
  select(null);
  const mina = minaScenarion();
  showPanel(`
    <h2>Scenarier</h2>
    <div class="meta">Egna kassaflödeskalkyler för en eller flera fastigheter</div>
    <p class="small">Starta från ett bolag (<strong>Räkna på innehavet</strong>), en fastighet (<strong>Räkna på fastigheten</strong>)
      eller filtret (<strong>Räkna på träffarna</strong>). Fyll i hyror, vakanser, kostnader och avkastningskrav, så räknar Horos
      fram kassaflöde och värde år för år. Spara för att få en länk att dela.</p>
    ${scenario ? `<button type="button" class="copy" data-sc="visa">Tillbaka till ${esc(scenario.data.namn || 'scenariot')}</button>` : ''}
    <h3>Mina scenarion</h3>
    ${table('<th>Scenario</th><th class="num">Sparat</th><th></th>', mina.map((x) =>
      `<tr><td><a data-sc="oppna" data-nyckel="${esc(x.nyckel)}">${esc(x.namn || 'Namnlöst scenario')}</a>
        <div class="muted small">${Number(x.antal).toLocaleString('sv-SE')} fastigheter</div></td>
        <td class="num">${esc(x.sparad)}</td><td class="num"><a data-sc="glom" data-nyckel="${esc(x.nyckel)}">Ta bort</a></td></tr>`),
      'Inga sparade scenarier i den här webbläsaren.')}
    <div class="meta small">Listan finns bara i den här webbläsaren; att ta bort ett scenario här tar inte bort länken.
      Ladda ner scenariofilen om du vill ha en egen kopia.</div>
    <label class="copy">Öppna scenariofil<input type="file" accept=".json,application/json" data-sc-fil hidden></label>
  `);
}

// Knappar med data-sc i panelen.
async function scenarioKlick(el) {
  const s = await statusP, a = el.dataset.sc;
  if (a === 'bolag' && bolagUrval) return nyttScenarioFran(bolagUrval.namn, bolagUrval.bet);
  if (a === 'fastighet') return nyttScenarioFran(el.dataset.bet, [el.dataset.bet]);
  if (a === 'visa') return visaScenario();
  if (a === 'lista') return openScenarier({ lista: true });
  if (a === 'lagg-till') {
    const r = await api('/api/underlag', { bet: [el.dataset.bet] }).catch(() => null);
    if (!r?.fastigheter.length || scenario.data.bet.length >= s.maxScenario) { el.textContent = 'Kunde inte läggas till'; return; }
    scenario.data.bet.push(r.fastigheter[0].beteckning);
    scenario.underlag.push(r.fastigheter[0]);
    andrat();
    rensaVy();
    Object.assign(el, { textContent: `Tillagd. Öppna ${scenario.data.namn || 'scenariot'}` });
    el.dataset.sc = 'visa';
    return;
  }
  if (a === 'ta-bort') {
    const bet = el.dataset.bet;
    scenario.data.bet = scenario.data.bet.filter((b) => b !== bet);
    scenario.underlag = scenario.underlag.filter((f) => f.beteckning !== bet);
    delete scenario.data.egna[bet];
    andrat();
    return visaScenario();
  }
  if (a === 'spara') return sparaScenario(el);
  if (a === 'csv') return laddaNer(`${filnamn()}.csv`, scenarioCsv(s), 'text/csv;charset=utf-8');
  if (a === 'fil') return laddaNer(`${filnamn()}.json`, JSON.stringify(scenario.data, null, 1), 'application/json');
  if (a === 'stang') {
    scenario = null;
    sparaUtkast();
    markera([]);
    return openScenarier({ lista: true });
  }
  const mina = minaScenarion(), x = mina.find((m) => m.nyckel === el.dataset.nyckel);
  if (a === 'oppna' && x) {
    history.replaceState(null, '', `${location.pathname}${location.search}${new URL(x.lank).hash}`);
    return oppnaScenarioLank(new URL(x.lank).hash);
  }
  if (a === 'glom') {
    sparaMina(mina.filter((m) => m !== x));
    return openScenarier({ lista: true });
  }
}

// Knappen i fastighetspanelen: lägg till i det öppna scenariot, eller börja ett nytt.
const scenarioKnapp = (bet) => (!scenario
  ? `<button type="button" class="copy" data-sc="fastighet" data-bet="${esc(bet)}">Räkna på fastigheten</button>`
  : scenario.data.bet.includes(bet)
    ? `<button type="button" class="copy" data-sc="visa">Öppna ${esc(scenario.data.namn || 'scenariot')}</button>`
    : `<button type="button" class="copy" data-sc="lagg-till" data-bet="${esc(bet)}">Lägg till i ${esc(scenario.data.namn || 'scenariot')}</button>`);
