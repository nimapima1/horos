// Panelvyer: fastighet, bolag, Om, Transaktioner och Största ägare. Bara deklarationer: laddas före app.js,
// som kopplar in dem (länkar, routning) och vars hjälpfunktioner (esc, showPanel, statusP …) de använder.
const demoTag = (d) => (d ? '<span class="tag">exempel</span>' : '');
// SCB:s villkor: den som sprider uppgifterna ska informera om reklamspärr.
const SPARR_TEXT = 'har frånsagt sig reklam via post, e-post och telefon';
const sparrTag = (x) => (x ? `<span class="tag" title="Företaget ${SPARR_TEXT} (SCB)">reklamspärr</span>` : '');
const SCB_KALLA = 'SCB, företagsregistret (egen bearbetning)';

function planInfo(plans) {
  const lista = (rules) => `<ul>${rules.map((b) => `<li>${b.etikett && b.etikett !== b.text ? `<strong>${esc(b.etikett)}</strong> · ` : ''}${esc(b.text)}${b.varde ? `<div class="small">Värde: ${esc(b.varde.typ)} ${esc(b.varde.tal)} ${esc(b.varde.enhet)}</div>` : ''}</li>`).join('')}</ul>`;
  return `<div class="plan-popup-body" tabindex="0" role="region" aria-label="Detaljplanens information">${plans.map((p) => `<section class="plan-info">
    <h3>${esc(p.namn || PLANTYP[p.typ] || 'Detaljplan')}</h3>
    <div class="muted">${esc(p.planid || 'Planbeteckning saknas')}</div>
    <p><strong>${esc(p.status || 'Status saknas')}</strong>${p.status && p.status !== 'laga kraft' ? '<br>Har inte fått laga kraft' : ''}</p>
    ${p.datum ? `<div>Laga kraft: ${esc(p.datum)}</div>` : ''}
    ${p.fastighetsmitt ? '<p class="small muted">Bestämmelserna nedan hämtas vid fastighetens kartmitt. Planen kan gälla bara en del av fastigheten. Klicka i planområdet på kartan för att kontrollera en annan punkt.</p>' : ''}
    <h4>${p.status === 'laga kraft' ? 'Planbestämmelser här' : 'Föreslagna planbestämmelser här'}</h4>
    ${p.bestammelseFel ? '<p>Kunde inte hämta bestämmelserna. Klicka på området för att försöka igen.</p>'
      : p.bestammelser === undefined ? '<p>Hämtar bestämmelser…</p>'
      : p.bestammelser === null ? `<p>${p.kalla === 'kommun' ? 'Kommunens karttjänst har bara planens gräns. Bestämmelserna står i plankartan.' : 'Bestämmelser har inte hämtats för den här planen ännu.'}</p>`
      : !p.bestammelser.length ? '<p>Inga bestämmelser i underlaget vid klickpunkten. Klicka längre in i området.</p>'
      : `${lista(p.bestammelser)}
        <p class="small muted">Gäller klickpunkten. Andra delar av planen kan ha andra regler. Bestämmelserna behöver läsas tillsammans med plankartan och avgör inte i sig om bygglov kan ges.</p>`}
    ${p.ovrigaBestammelser?.length ? `<details><summary>Linje- och punktbestämmelser i planen (${p.ovrigaBestammelser.length})</summary>
      <p class="small muted">Gäller särskilda linjer eller punkter, inte hela planområdet. Kontrollera läget i plankartan.</p>${lista(p.ovrigaBestammelser)}</details>` : ''}
    <p class="small muted">${p.kalla === 'ngp' ? 'Kommunen via Nationella geodataplattformen. Äldre planer kan saknas.' : p.kalla === 'kommun' ? 'Källa: kommunens karttjänst.' : 'Källa: Lantmäteriet.'}${p.demo ? ' Exempeldata.' : ''}</p>
    ${p.dokument?.length ? `<p>${p.dokument.filter((d) => {
      if (/^\/plandokument\/([a-f0-9]{64}|ngp\/[0-9a-f-]{36})\.pdf$/.test(d.url)) return true;
      try { const u = new URL(d.url); return u.protocol === 'https:' && !u.username && !u.password; } catch { return false; }
    }).map((d) => `<a href="${esc(d.url)}" target="_blank" rel="noopener noreferrer">${esc(d.titel)} ↗</a>`).join(' · ')}</p>`
      : '<div class="small muted">Dokumentlänkar har inte hämtats för planen ännu.</div>'}
  </section>`).join('')}</div>`;
}
const bolagLink = (orgnr, namn, demo) =>
  `<a data-bolag="${esc(orgnr)}">${esc(namn ?? fmtOrgnr(orgnr))}</a>${demoTag(demo)}`;
const bboxAttr = (f) => `data-bbox="${[f.minx, f.miny, f.maxx, f.maxy].join(',')}"`;
// Tabell med rubrikrad, eller ett meddelande om raderna saknas.
const table = (head, rows, empty) => (rows.length
  ? `<table><tr>${head}</tr>${rows.join('')}</table>`
  : `<p class="empty">${empty}</p>`);
const MANADER = ['jan', 'feb', 'mar', 'apr', 'maj', 'jun', 'jul', 'aug', 'sep', 'okt', 'nov', 'dec'];
// Datumkolumn: "2026-10-10" -> "10 okt" med året under, så att kolumnen blir smal.
const dagCell = (d) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(d ?? '');
  return `<td class="dag">${m ? `${+m[3]} ${MANADER[m[2] - 1]}<div class="muted small">${m[1]}</div>` : esc(d ?? '')}</td>`;
};
// Nyckeltal överst i panelen: [[etikett, värde, undertext], ...]
const stats = (items) => `<div class="stats">${items.map(([label, value, sub]) =>
  `<div class="stat"><div class="stat-label">${label}</div><div class="stat-value">${value}</div>${sub ? `<div class="fact-sub">${sub}</div>` : ''}</div>`).join('')}</div>`;

// MIFO-riskklasser i länsstyrelsernas EBH-stöd.
const RISKKLASS = { 1: '1, mycket stor risk', 2: '2, stor risk', 3: '3, måttlig risk', 4: '4, liten risk' };
const avstand = (m, inuti) => (m === 0 ? inuti : m < 1000 ? `${m} m` : `${(m / 1000).toLocaleString('sv-SE', { maximumFractionDigits: 1 })} km`);

// Hämtar från API:t; vid fel visas felet i panelen och null returneras.
async function apiPanel(path) {
  try { return await api(path); }
  catch (e) { showPanel(`<p class="empty">${esc(e.message)}</p>`); return null; }
}

// Det de flesta letar efter, överst: [[etikett, värde, undertext], ...]
const facts = (items) => `<div class="facts">${items.map(([label, value, sub]) =>
  `<div class="fact"><div class="stat-label">${label}</div><div class="fact-value">${value}</div>${sub ? `<div class="fact-sub">${sub}</div>` : ''}</div>`).join('')}</div>`;

// SCB:s storleksklasser för antal anställda (kod 0–16) och ett mittvärde per klass för viktningen.
const ANSTKL = ['okänt', 'inga', '1–4', '5–9', '10–19', '20–49', '50–99', '100–199', '200–499',
  '500–999', '1 000–1 499', '1 500–1 999', '2 000–2 999', '3 000–3 999', '4 000–4 999', '5 000–9 999', '10 000–'];
// Färg per lokaltyp efter platsen i serverns lista (status.lokaltyper); Övrigt och okända blir grå.
const LOKALFARGER = ['--c1', '--c2', '--c3', '--c4', '--c6', '--c5'];
// [{typ, loa_m2}] från API:t -> med färg och andel av den totala ytan.
function uppskattadAnvandning(anvandning, lokaltyper) {
  const summa = anvandning.reduce((s, r) => s + r.loa_m2, 0);
  return anvandning.map((r) => ({ typ: r.typ, farg: LOKALFARGER[lokaltyper.indexOf(r.typ)] ?? '--v0', loa: r.loa_m2, andel: r.loa_m2 / summa }));
}
const ungefarM2 = (m2) => `≈ ${(Math.round(m2 / (m2 < 1000 ? 10 : 100)) * (m2 < 1000 ? 10 : 100)).toLocaleString('sv-SE')} m²`;
const procent = (x) => `${Math.round(x * 100)} %`;

// Rutan Användning: taxeringstypen och uppskattad fördelning på lokaltyper med LOA.
// s: /api/status (s.foretag: företagsuppgifterna är inlästa, så att en tom lista betyder "inga företag").
function anvandningRuta(typer, ar, anvandning, loa, s) {
  const rader = uppskattadAnvandning(anvandning, s.lokaltyper);
  return `<section class="anv" aria-labelledby="anv-rubrik">
    <div class="stat-label" id="anv-rubrik">Användning</div>
    <div class="fact-value">${rader.length ? `${esc(rader[0].typ)} ${procent(rader[0].andel)}` : typer.length ? esc(typer.join(' · ')) : '–'}</div>
    <div class="fact-sub">${!typer.length ? 'Taxering: väntar på uppgifter från Skatteverket'
      : rader.length ? `Taxering ${ar}: ${esc(typer.join(' · '))}` : `Enligt taxeringen ${ar}`}</div>
    ${rader.length ? `
      <div class="anv-bar" aria-hidden="true">${rader.map((r) => `<span style="flex:${r.andel};background:var(${r.farg})"></span>`).join('')}</div>
      <table class="anv-tab">
        <tr><th>Lokaltyp</th><th class="num">Andel av yta</th><th class="num">Uppskattad LOA</th></tr>
        ${rader.map((r) => `<tr><td><i style="background:var(${r.farg})"></i>${esc(r.typ)}</td>
          <td class="num">${procent(r.andel)}</td><td class="num">${ungefarM2(r.loa)}</td></tr>`).join('')}
        <tr class="anv-summa"><td>Totalt</td><td></td><td class="num">${ungefarM2(loa)}</td></tr>
      </table>
      <div class="fact-sub">Uppskattat från branscher och antal anställda hos företagen på fastigheten (källa: ${SCB_KALLA}).
        Grov indikation, inte uppmätt yta.</div>` : `<div class="fact-sub">${s.foretag ? 'Ingen uppskattning: inga företag registrerade på fastigheten.' : 'Ingen uppskattning ännu.'}</div>`}
  </section>`;
}

// Företag på fastigheten, en grupp per adress som hos SCB.
function hyresgastTabell(hyresgaster) {
  const perAdress = new Map();
  for (const h of hyresgaster) {
    const k = h.adress ?? 'Adress saknas';
    (perAdress.get(k) ?? perAdress.set(k, []).get(k)).push(h);
  }
  // Adresserna i gatuordning (92 före 92A före 94), "Adress saknas" sist; företagen störst först.
  const adresser = [...perAdress].sort(([x], [y]) => (x === 'Adress saknas') - (y === 'Adress saknas')
    || x.localeCompare(y, 'sv', { numeric: true }));
  const rader = adresser.flatMap(([adress, lista]) => [
    ...(perAdress.size > 1 ? [`<tr><td colspan="2"><strong>${esc(adress)}</strong></td></tr>`] : []),
    ...lista.map((h) => `<tr><td>${bolagLink(h.orgnr, h.namn ?? h.benamning, h.demo)}${sparrTag(h.reklamsparr)}${h.benamning && h.namn && h.benamning !== h.namn ? ` · ${esc(h.benamning)}` : ''}
      <div class="muted small">${esc(h.bransch ?? (h.sni ? `SNI ${h.sni}` : ''))}</div></td>
      <td class="num">${esc(ANSTKL[h.anstkl] ?? '–')}</td></tr>`),
  ]);
  return table('<th>Företag</th><th class="num">Anställda</th>', rader, 'Inga uppgifter om företag på fastigheten.');
}

// adress: söktexten när fastigheten öppnades från en adressträff.
async function openFastighet(bet, adress) {
  const [f, s] = await Promise.all([apiPanel(`/api/fastighet/${encodeURIComponent(bet)}`), statusP]);
  if (!f) return;
  rensaVy();
  select(f.beteckning);
  // Senaste taxeringsåret: värdet är summan av fastighetens taxeringsenheter.
  const ar = f.taxering[0]?.ar;
  const senaste = f.taxering.filter((t) => t.ar === ar);
  const varde = senaste.reduce((s, t) => s + (t.varde_tkr ?? 0), 0);
  // Förändring mot förra taxeringsåret med värde (taxeringen är sorterad nyast först).
  const forraAr = f.taxering.find((t) => t.ar < ar && t.varde_tkr != null)?.ar;
  const forra = forraAr && f.taxering.filter((t) => t.ar === forraAr).reduce((s, t) => s + (t.varde_tkr ?? 0), 0);
  const andring = forra ? (varde - forra) / forra : null;
  const kop = f.transaktioner.find((x) => x.forvarvare_orgnr && x.kopeskilling_kr != null);
  // Nyckeltal bara när köpet gällde hela fastigheten och bara den (inte en andel eller en paketaffär).
  const paket = kop?.i_affar > 1;
  const helKop = kop && (!kop.andel || kop.andel === '1/1') && !paket;
  // Lagfarna ägare, annars ägarna i taxeringen.
  const agare = f.agare.length ? f.agare
    : [...new Map(senaste.filter((t) => t.agare_orgnr).map((t) => [t.agare_orgnr, { orgnr: t.agare_orgnr, namn: t.agare_namn }])).values()];
  const anvandning = [...new Set(senaste.map((t) => t.typ).filter(Boolean))];
  const loa = f.anvandning.reduce((s, r) => s + r.loa_m2, 0);
  const rubrik = adress ?? f.adresser[0] ?? f.beteckning;
  const ovriga = f.adresser.filter((a) => a !== rubrik);
  showPanel(`
    ${scenarioMeny(f.beteckning)}
    <h2>${esc(rubrik)}${demoTag(f.demo)}</h2>
    <div class="meta">${rubrik === f.beteckning ? '' : `${esc(f.beteckning)} · `}${esc(f.kommun ?? '')}</div>
    ${ovriga.length ? `<div class="meta small">Även ${esc(ovriga.join(', '))}</div>` : ''}
    <div data-streetview></div>
    ${facts([
      [agare[0]?.tomtratt ? 'Tomträttshavare' : 'Ägare', agare.length ? bolagLink(agare[0].orgnr, agare[0].namn, agare[0].demo) : '–',
        [agare.length > 1 ? `och ${agare.length - 1} till, se nedan` : agare.length ? fmtOrgnr(agare[0].orgnr) : 'Väntar på uppgifter från Lantmäteriet',
          agare[0]?.inskrivningsdag ? `${agare[0].tomtratt ? "tomträttshavare" : "ägare"} sedan ${esc(agare[0].inskrivningsdag)}` : ''].filter(Boolean).join(' · ')],
      ['Senaste köp', kop ? mkr(kop.kopeskilling_kr / 1000) : '–',
        kop ? `${esc(kop.inskrivningsdag ?? '')}${kop.forvarvare_namn ? ` · ${esc(kop.forvarvare_namn)}` : ''}${paket ? ` · paketaffär, ${kop.i_affar} fastigheter` : ''}` : 'Inga registrerade köp'],
    ])}
    ${anvandningRuta(anvandning, ar, f.anvandning, loa, s)}
    ${stats([
      [`Taxeringsvärde${ar ? ` ${ar}` : ''}`, f.taxering.length ? mkr(varde) : '–'],
      ['Upplåtelseform', Object.fromEntries(s.upplatelseformer)[f.upplatelse] ?? '–', f.upplatelse ? 'Enligt Lantmäteriet' : 'Uppgift saknas'],
      ...(andring != null ? [[`Ändring sedan ${forraAr}`, `${andring > 0 ? '+' : ''}${(andring * 100).toLocaleString('sv-SE', { maximumFractionDigits: 0 })} %`]] : []),
      ['Tomtareal', f.areal_m2 ? `${Math.round(f.areal_m2).toLocaleString('sv-SE')} m²` : '–'],
      // shortcut: BOA och uppmätt LOA finns i taxeringen (Skatteverket) men saknas i data än; tills dess uppskattad LOA.
      ['LOA / BOA', loa ? ungefarM2(loa) : '–', `${loa ? 'LOA uppskattad' : 'LOA saknas'} · BOA saknas`],
      // Exploateringstal: (LOA + BOA) delat med tomtarealen.
      ['Exploateringstal', loa && f.areal_m2 ? `≈ ${(loa / f.areal_m2).toLocaleString('sv-SE', { maximumFractionDigits: 1 })}` : '–',
        loa && f.areal_m2 ? 'Uppskattat, utan BOA' : ''],
      ...(helKop ? [
        ['Köp per m² tomt', f.areal_m2 ? kr(kop.kopeskilling_kr / f.areal_m2) : '–'],
        // K/T: köpeskilling delad med taxeringsvärde.
        ['K/T-kvot', varde ? (kop.kopeskilling_kr / (varde * 1000)).toLocaleString('sv-SE', { maximumFractionDigits: 2 }) : '–'],
      ] : []),
    ])}
    ${s.foretag ? `<h3>Företag på adressen</h3>
    <div class="meta small">Företag med arbetsställe på fastigheten enligt SCB:s företagsregister. Det säger inget om hyresavtal.${f.hyresgaster.some((h) => h.reklamsparr) ? `
      Företag märkta reklamspärr ${SPARR_TEXT}.` : ''}</div>
    ${hyresgastTabell(f.hyresgaster)}` : ''}
    <h3>Detaljplan</h3>
    ${table('<th>Plan</th><th>Status</th><th class="num">Laga kraft</th>', f.planer.map((p) =>
      `<tr><td><strong>${esc(PLANTYP[p.typ] ?? p.typ)}</strong>${p.namn ? ` · ${esc(p.namn)}` : ''}${demoTag(p.demo)}
        <div class="muted small">${esc(p.planid ?? '')}</div><button type="button" data-visa-plan data-plan="${esc(JSON.stringify([p]))}" data-punkt="${esc(JSON.stringify({ lng: (f.minx + f.maxx) / 2, lat: (f.miny + f.maxy) / 2 }))}">Visa detaljplan</button></td><td>${p.status === 'laga kraft' ? 'Laga kraft' : p.status ? `<strong>${esc(p.status)}</strong><div class="muted small">Har inte fått laga kraft</div>` : 'Status saknas'}</td><td class="num">${esc(p.datum ?? '')}</td></tr>`),
      'Inga planuppgifter i Horos för fastigheten.')}
    ${f.planer.some((p) => p.kalla === 'ngp') ? '<div class="meta small">Källa: kommunerna via Nationella geodataplattformen. Äldre planer kan saknas. Pågående planer visar planprocessens status och kan ändras.</div>' : ''}
    ${f.planer.some((p) => p.kalla === 'kommun') ? '<div class="meta small">Äldre planer: kommunens egen karttjänst.</div>' : ''}
    <h3>${f.agare.some((a) => a.tomtratt) ? 'Ägare och tomträttshavare' : 'Lagfarna ägare'}</h3>
    ${table('<th>Ägare</th><th>Andel</th><th class="num">Sedan</th>', f.agare.map((a) =>
      `<tr><td>${bolagLink(a.orgnr, a.namn, a.demo)}<div class="muted small">${fmtOrgnr(a.orgnr)}${a.tomtratt ? ' · tomträttshavare' : ''}</div></td>
        <td>${esc(a.andel ?? '')}</td><td class="num">${esc(a.inskrivningsdag ?? '')}</td></tr>`),
      'Väntar på uppgifter från Lantmäteriet.')}
    <h3>Grannfastigheter i Horos</h3>
    ${table('<th>Fastighet</th><th>Ägare</th>', f.grannar.map((g) =>
      `<tr><td><a data-fastighet="${esc(g.beteckning)}" ${bboxAttr(g)}>${esc(g.beteckning)}</a></td>
        <td>${g.orgnr ? bolagLink(g.orgnr, g.agare, g.demo) : '–'}</td></tr>`),
      'Inga bolagsägda grannfastigheter.')}
    <h3>Taxering</h3>
    ${table('<th>År</th><th>Typ</th><th class="num">Värde</th>', f.taxering.map((t) =>
      `<tr><td>${t.ar ?? ''}</td><td>${esc(t.typ ?? '')}</td><td class="num">${mkr(t.varde_tkr)}</td></tr>
        <tr><td></td><td class="muted small" colspan="2">Mark ${mkr(t.markvarde_tkr)} · Byggnad ${mkr(t.byggvarde_tkr)}${t.taxeringsenhet ? ` · Enhet ${esc(t.taxeringsenhet)}` : ''}</td></tr>`),
      'Väntar på uppgifter från Skatteverket.')}
    <h3>Överlåtelser</h3>
    ${table('<th>Datum</th><th>Förvärvare</th><th class="num">Köpeskilling</th>', f.transaktioner.flatMap((x, i) => {
      if (x.privat || !x.forvarvare_orgnr) return [];
      // Säljaren är förvärvaren i överlåtelsen före (listan är nyast först), om den finns i Horos.
      const fore = f.transaktioner[i + 1];
      const fran = fore?.forvarvare_orgnr && fore.forvarvare_orgnr !== x.forvarvare_orgnr
        ? `från ${bolagLink(fore.forvarvare_orgnr, fore.forvarvare_namn)}` : '';
      return `<tr>${dagCell(x.inskrivningsdag)}
        <td>${x.forvarvare_orgnr ? bolagLink(x.forvarvare_orgnr, x.forvarvare_namn) : '–'}<div class="muted small">${[esc(x.art ?? ''), fran].filter(Boolean).join(' · ')}</div></td>
        <td class="num">${kr(x.kopeskilling_kr)}</td></tr>`;
    }), 'Inga registrerade överlåtelser.')}
    ${f.nyheter.length ? `<h3>I pressmeddelanden och nyheter</h3>
    ${table('<th>Datum</th><th>Affär</th><th class="num">Pris</th>', f.nyheter.map(nyhetRad), '')}` : ''}
    <h3>Köp i närheten</h3>
    <div class="meta small">Inom cirka 300 meter, senaste först.</div>
    ${table('<th>Datum</th><th>Fastighet och köpare</th><th class="num">Pris</th>', f.narKop.map((x) =>
      `<tr>${dagCell(x.dag)}
        <td><a data-fastighet="${esc(x.beteckning)}" ${bboxAttr(x)}>${esc(x.beteckning)}</a>
          <div class="muted small">${x.orgnr ? bolagLink(x.orgnr, x.namn, x.demo) : '–'}</div></td>
        <td class="num">${mkr(x.kr / 1000)}<div class="muted small">${x.paket ? 'paketaffär'
          : x.areal_m2 && (!x.andel || x.andel === '1/1') ? `${kr(x.kr / x.areal_m2)}/m²` : ''}</div></td></tr>`),
      'Inga registrerade köp i närheten.')}
    ${f.fororenade ? `<h3>Förorenade områden</h3>
    <div class="meta small">${f.fororenade.length > 10 ? `${f.fororenade.length} objekt, de 10 med högst riskklass visas. ` : ''}Objekt i
      länsstyrelsernas register inom 150 meter. Att ett objekt finns med betyder inte att marken är förorenad, och mark kan
      vara förorenad utan att finnas med.</div>
    ${table('<th>Bransch</th><th>Riskklass</th><th class="num">Avstånd</th>', f.fororenade.slice(0, 10).map((x) =>
      `<tr><td>${esc(x.bransch ?? '–')}<div class="muted small">${[x.status, x.bransch2].filter(Boolean).map(esc).join(' · ')}</div></td>
        <td>${RISKKLASS[x.riskklass] ?? 'Ej klassad'}</td><td class="num">${avstand(x.avstand_m, 'på fastigheten')}</td></tr>`),
      'Inga registrerade objekt inom 150 meter.')}` : ''}
    ${f.utsatta ? `<h3>Utsatta områden</h3>
    <div class="meta small">Polisens lägesbild över utsatta områden, inom 5 km från fastigheten.</div>
    ${table('<th>Område</th><th class="num">Avstånd</th>', f.utsatta.map((u) =>
      `<tr><td>${esc(u.namn)}<div class="muted small">${[u.kategori, u.ort, u.datum && `sedan ${u.datum}`].filter(Boolean).map(esc).join(' · ')}</div></td>
        <td class="num">${avstand(u.avstand_m, 'inom området')}</td></tr>`),
      'Inga utsatta områden inom 5 km.')}` : ''}
    <button type="button" class="copy" data-copy>Kopiera länk till fastigheten</button>
    ${googleLankar(mittpunkt(f))}
    <p class="muted small" style="margin-top:16px">${[
      `Gränser: ${f.kalla === 'demo' ? 'OpenStreetMap (exempel)' : 'Lantmäteriet'}`,
      f.planer.length && `planer: ${f.planer.some((p) => p.demo) ? 'påhittade (exempel)' : 'Lantmäteriet'}`,
      f.adresser.length && 'adresser: © OpenStreetMap-bidragsgivare',
      f.fororenade?.length && 'förorenade områden: Länsstyrelserna, EBH-stödet (CC BY 4.0)',
      f.utsatta?.length && 'utsatta områden: Polisen',
      f.hyresgaster.length && `företag: ${f.hyresgaster.some((h) => h.demo) ? 'påhittade (exempel)' : SCB_KALLA}`,
    ].filter(Boolean).join(' · ')}</p>
  `);
  streetView.visa(mittpunkt(f), s.streetview);
}

async function openBolag(orgnr) {
  const b = await apiPanel(`/api/bolag/${orgnr}`);
  if (!b) return;
  rensaVy();
  select(null);
  // Summor, inramning och markering gäller alla fastigheter; listan nedan är kapad (b.summa.antal).
  const s = b.summa;
  markera(s.beteckningar, s.antal ? b.orgnr : null);
  bolagUrval = { namn: b.namn, bet: s.beteckningar };
  const ram = s.antal && [s.minx, s.miny, s.maxx, s.maxy].join(',');
  showPanel(`
    <h2>${esc(b.namn)}${demoTag(b.demo)}</h2>
    <div class="meta">${fmtOrgnr(b.orgnr)}${b.avregistrerad ? ` · <strong>avregistrerad ${esc(b.avregistrerad)}</strong>` : ''}</div>
    ${stats([['Fastigheter', s.antal.toLocaleString('sv-SE')], ['Taxeringsvärde', s.varde_tkr ? mkr(s.varde_tkr) : '–'],
      ['Tomtareal', s.areal_m2 ? `${Math.round(s.areal_m2).toLocaleString('sv-SE')} m²` : '–']])}
    ${ram ? `<div class="knappar"><button type="button" class="copy" data-ram="${ram}">Visa alla på kartan</button>
      ${bolagScenarioKnapp()}</div>
      <div class="meta small">Bolagets fastigheter är inramade i orange.</div>` : ''}
    <dl>
      <dt>Form</dt><dd>${esc(b.jurform ?? '–')}</dd>
      <dt>SNI</dt><dd>${esc(b.sni ?? '–')}</dd>
      <dt>Adress</dt><dd>${esc([b.adress, [b.postnr, b.postort].filter(Boolean).join(' ')].filter(Boolean).join(', ') || '–')}</dd>
      <dt>Registrerad</dt><dd>${esc(b.registrerad ?? '–')}</dd>
    </dl>
    ${b.demo ? '' : `<p class="small">Mer om bolaget:
      <a href="https://foretagsinfo.bolagsverket.se/sok-foretagsinformation-web/foretag/${esc(b.orgnr)}" target="_blank" rel="noopener noreferrer">Bolagsverket</a>
      (grunduppgifter) ·
      <a href="https://www.allabolag.se/${esc(b.orgnr)}" target="_blank" rel="noopener noreferrer">Allabolag</a>
      (bokslut, koncern)</p>`}
    ${b.verksamhet ? `<h3>Verksamhet</h3><p class="small">${esc(b.verksamhet)}</p>` : ''}
    <h3>Fastigheter</h3>
    ${s.antal > b.fastigheter.length ? `<div class="meta small">Visar de ${b.fastigheter.length.toLocaleString('sv-SE')} med högst taxeringsvärde av ${s.antal.toLocaleString('sv-SE')}.</div>` : ''}
    ${table('<th>Beteckning</th><th class="num">Taxeringsvärde</th>', b.fastigheter.map((f) =>
      `<tr><td><a data-fastighet="${esc(f.beteckning)}" ${bboxAttr(f)}>${esc(f.beteckning)}</a></td>
        <td class="num">${mkr(f.varde_tkr)}</td></tr>`),
      'Inga kända fastigheter ännu. Ägaruppgifter läses in när Lantmäteriet har svarat.')}
    ${b.arbetsstallen.length ? `<h3>Arbetsställen i Horos</h3>
    ${table('<th>Adress</th><th class="num">Anställda</th>', b.arbetsstallen.map((a) =>
      `<tr><td>${esc(a.adress ?? 'Adress saknas')}${a.benamning ? ` · ${esc(a.benamning)}` : ''}${sparrTag(a.reklamsparr)}
        <div class="muted small">${fastighetLink(a)}${a.bransch ? ` · ${esc(a.bransch)}` : ''}</div></td>
        <td class="num">${esc(ANSTKL[a.anstkl] ?? '–')}</td></tr>`), '')}` : ''}
    <h3>Köp</h3>
    ${table('<th>Datum</th><th>Fastighet</th><th class="num">Pris</th>', b.kop.map((x) =>
      `<tr>${dagCell(x.dag)}<td>${fastighetLink(x)}</td><td class="num">${x.kr == null ? '–' : mkr(x.kr / 1000)}</td></tr>`),
      'Inga registrerade köp.')}
    <h3>Sålt</h3>
    ${table('<th>Fastighet</th><th class="num">Köpt</th><th class="num">Sålt</th>', b.salt.map((x) => {
      const ar = x.kopt && x.salt ? (Date.parse(x.salt) - Date.parse(x.kopt)) / (365.25 * 864e5) : null;
      return `<tr><td>${fastighetLink(x)}<div class="muted small">${x.kopare_orgnr ? `till ${bolagLink(x.kopare_orgnr, x.kopare)}` : ''}${ar != null ? `${x.kopare_orgnr ? ' · ' : ''}ägd ${ar.toLocaleString('sv-SE', { maximumFractionDigits: 1 })} år` : ''}</div></td>
        <td class="num">${esc(x.kopt ?? '')}<div class="muted small">${x.kop_kr == null ? '–' : mkr(x.kop_kr / 1000)}</div></td>
        <td class="num">${esc(x.salt ?? '')}<div class="muted small">${x.salt_kr == null ? '–' : mkr(x.salt_kr / 1000)}</div></td></tr>`;
    }), 'Inga registrerade försäljningar.')}
    <p class="muted small" style="margin-top:16px">Källa: Bolagsverket och SCB, värdefulla datamängder. Köp och försäljningar: Lantmäteriet.${b.arbetsstallen.length ? ` Arbetsställen: ${SCB_KALLA}.` : ''}</p>
  `);
}

// Om Horos.
async function openOm() {
  const s = await statusP;
  select(null);
  showPanel(`
    <h2>Horos</h2>
    <div class="meta">Öppen karta över bolagsägda fastigheter i Stockholm</div>
    <p>I antikens Athen ställdes gränsstenar, <em>horoi</em> (ὅροι), ut på tomter för att
      offentligt visa vem som hade anspråk på marken. Horos gör samma sak med dagens offentliga uppgifter:
      vilka bolag, föreningar och kommuner som äger fastigheterna, deras taxeringsvärden och vad de har köpts för.</p>
    <h3>Det här kan du göra</h3>
    <ul class="small">
      <li>Klicka på en fastighet för ägare, användning, senaste köp, grannar och köp i närheten.</li>
      <li>Klicka på ett bolag och välj <strong>Visa alla på kartan</strong> för att se hela innehavet.</li>
      <li>Använd <strong>Filter</strong> för att hitta fastigheter efter användning, ägartyp, värde och köp,
        och ladda ner träffarna som CSV.</li>
      <li>Byt <strong>Färga efter</strong> i teckenförklaringen för att se värde, användning, ägartyp eller köpår.</li>
      <li><a href="#transaktioner">Transaktioner</a> och <a href="#agare">Ägare</a> sammanfattar köpen och de största ägarna.</li>
      <li><a href="#scenario">Scenarier</a>: räkna kassaflöde och värde för en eller flera fastigheter med egna antaganden,
        och dela kalkylen som en länk. Lägg till en fastighet med <strong>+</strong> i fastighetspanelen (välj scenario)
        eller i sökningen (det öppna scenariot), eller ett helt bolag eller filtrets träffar.</li>
      <li>Adressen i webbläsaren sparar kartläge, filter och vald fastighet, så att du kan dela länken.</li>
    </ul>
    <h3>Källor</h3>
    <dl>
      <dt>Bolag</dt><dd>Bolagsverket och SCB, värdefulla datamängder</dd>
      <dt>Gränser</dt><dd>Lantmäteriet, Fastighetsindelning</dd>
      <dt>Taxering</dt><dd>Skatteverket, allmänna handlingar</dd>
      <dt>Ägare, köp</dt><dd>Lantmäteriet, allmänna handlingar</dd>
      <dt>Planer</dt><dd>Lantmäteriet, Markreglerande bestämmelse</dd>
      ${s.foretag ? `<dt>Företag</dt><dd>${SCB_KALLA}, arbetsställen</dd>` : ''}
      <dt>Förorenade områden</dt><dd>Länsstyrelserna, EBH-stödet (CC BY 4.0)</dd>
      <dt>Adresser</dt><dd>© OpenStreetMap-bidragsgivare (ODbL)</dd>
      <dt>Karta</dt><dd>OpenFreeMap, © OpenStreetMap-bidragsgivare</dd>
      <dt>Satellit</dt><dd>EOxCloudless 2025 (Copernicus Sentinel-2)</dd>
      <dt>Flygfoton</dt><dd>Lantmäteriet, historiska ortofoton 1960–2005 (CC0)</dd>
    </dl>
    <h3>Integritet</h3>
    <p>Horos visar bara fastigheter som ägs av juridiska personer. Uppgifter om privatpersoner
      samlas inte in och visas inte. Sidan använder inga kakor och sparar inte besökarnas IP-adresser.
      Street View laddas från Google först när du klickar på knappen. Ett scenario som du sparar lagras på servern
      utan koppling till dig, och alla som har länken kan se det; Mina scenarion finns bara i din webbläsare.</p>
    <p><a href="metod.html">Metod, begränsningar och nedladdning av datan →</a></p>
  `);
}

// Väljare i panelvyerna: <select> med tomt värde = alla.
const options = (list, value, alla) => [alla != null ? `<option value="">${esc(alla)}</option>` : '',
  ...list.map((o) => { const [v, text] = Array.isArray(o) ? o : [o, o];
    return `<option value="${esc(v)}"${String(v) === String(value ?? '') ? ' selected' : ''}>${esc(text)}</option>`; })].join('');
const field = (label, name, opts) => `<label>${label}<select name="${name}">${opts}</select></label>`;
const bar = (andel) => `<div class="bar"><i style="width:${Math.max(1, Math.round(andel * 100))}%"></i></div>`;
const fastighetLink = (r) => `<a data-fastighet="${esc(r.beteckning)}" ${bboxAttr(r)}>${esc(r.beteckning)}</a>`
  + (r.antal > 1 ? ` <span class="muted small">+ ${r.antal - 1} till</span>` : '');
// Mitten av fastighetens bbox som "lat,lon" för Google (länkarna och Street View-rutan i app.js).
// shortcut: mitten av bbox kan hamna utanför en L-formad fastighet; byt mot en punkt i polygonen om det stör.
const mittpunkt = (f) => f.minx == null ? null : `${((f.miny + f.maxy) / 2).toFixed(6)},${((f.minx + f.maxx) / 2).toFixed(6)}`;
// Vanliga länkar: inget skickas till Google förrän besökaren klickar.
const googleLankar = (p) => {
  if (!p) return '';
  const a = (href, text) => `<a href="${href}" target="_blank" rel="noopener noreferrer">${text}</a>`;
  return `<p class="small">Öppna i ${a(`https://www.google.com/maps/search/?api=1&amp;query=${p}`, 'Google Maps')} ·
    ${a(`https://www.google.com/maps/@?api=1&amp;map_action=pano&amp;viewpoint=${p}`, 'Street View')}</p>`;
};
const affarRad = (r) => `<tr>${dagCell(r.dag)}
  <td>${fastighetLink(r)}<div class="muted small">${r.orgnr ? bolagLink(r.orgnr, r.namn, r.demo) : '–'}${r.saljare_orgnr && r.saljare_orgnr !== r.orgnr ? ` från ${bolagLink(r.saljare_orgnr, r.saljare)}` : ''}</div></td>
  <td class="num">${mkr(r.kr / 1000)}</td></tr>`;

// Affär ur ett pressmeddelande: rubriken länkar till källan, "Visa på kartan" ramar in fastigheterna.
// Kommunen visas inte (står oftast i rubriken); källan (MFN, tidningen) står under priset.
const nyhetRad = (n) => {
  const press = n.kalla === 'cision' || n.kalla === 'mfn';
  const rad = [press && `${esc(n.utgivare)} ${n.typ === 'kop' ? 'köper' : 'säljer'}`, n.minx != null
    && `<a data-ram="${[n.minx, n.miny, n.maxx, n.maxy].join(',')}" data-markera="${esc(JSON.stringify(n.beteckningar))}">Visa på kartan</a>`].filter(Boolean);
  const kalla = n.kalla === 'mfn' ? 'via MFN' : press ? '' : `Enligt ${esc(n.utgivare)}`;
  return `<tr>${dagCell(n.dag)}
  <td><a href="${esc(n.url)}" target="_blank" rel="noopener">${esc(n.rubrik)}</a>${rad.length ? `<div class="muted small">${rad.join(' · ')}</div>` : ''}</td>
  <td class="num">${n.pris_kr ? mkr(n.pris_kr / 1000) : '–'}${kalla ? `<div class="muted small kalla">${kalla}</div>` : ''}</td></tr>`;
};

// Transaktioner: volym, antal och de senaste och största köpen, som Datschas transaktionsöversikt.
async function openAffarer(p = {}) {
  const [s, a] = await Promise.all([statusP, apiPanel(`/api/affarer?${new URLSearchParams(p)}`)]);
  if (!a) return;
  select(null);
  const perKat = new Map();
  for (const t of a.perTyp) {
    const k = anvKat(t.typ), v = perKat.get(k) ?? { antal: 0, kr: 0 };
    perKat.set(k, { antal: v.antal + t.antal, kr: v.kr + (t.kr ?? 0) });
  }
  const kat = [...perKat].sort((x, y) => y[1].kr - x[1].kr);
  const n = (x) => x.toLocaleString('sv-SE');
  showPanel(`
    <h2>Transaktioner</h2>
    <div class="meta">Köp med köpeskilling ur lagfarterna. En paketaffär räknas en gång.</div>
    <form class="view-form" data-view="affarer">
      ${field('Kommun', 'kommun', options(s.kommuner ?? [], a.kommun, 'Alla kommuner'))}
      ${field('År', 'ar', options(a.arLista, a.ar))}
      ${field('Köpeskilling', 'min', options([[0, 'Alla'], [10, 'Över 10 Mkr'], [40, 'Över 40 Mkr'], [100, 'Över 100 Mkr']], a.min))}
      <label class="hel">Sök transaktioner<input type="search" name="sok" value="${esc(p.sok ?? '')}"
        placeholder="Fastighet, köpare, säljare eller org.nr" maxlength="60" autocomplete="off" enterkeyhint="search"></label>
    </form>
    ${a.sok ? `<h3>Träffar för ”${esc(p.sok)}”</h3>
    <div class="meta small">Alla år${a.traffar.length === 50 ? ', de 50 senaste' : ''}.</div>
    ${table('<th>Datum</th><th>Fastighet och köpare</th><th class="num">Pris</th>', a.traffar.map(affarRad), 'Inga transaktioner hittades.')}` : ''}
    ${a.nyheter.length ? `<h3>Senaste i pressmeddelanden och nyheter</h3>
    <div class="meta small">Fastighetsbolagens pressmeddelanden (Cision, MFN) och notiser i Fastighetsvärlden. Pris enligt källan; affären syns i lagfarterna några månader senare.</div>
    ${table('<th>Datum</th><th>Affär</th><th class="num">Pris</th>', a.nyheter.map(nyhetRad), '')}` : ''}
    ${a.ar ? `
    ${stats([[`Volym ${a.ar}`, mkr((a.summa.kr ?? 0) / 1000)], [`Transaktioner ${a.ar}`, n(a.summa.antal)],
      ['Senaste 30 dagarna', `${n(a.dagar30.antal)} st · ${mkr((a.dagar30.kr ?? 0) / 1000)}`]])}
    <h3>Per användning ${a.ar}</h3>
    ${table('<th>Användning</th><th class="num">Antal</th><th class="num">Volym</th>', kat.map(([k, v]) =>
      `<tr><td>${esc(k)}${bar(v.kr / (a.summa.kr || 1))}</td><td class="num">${n(v.antal)}</td><td class="num">${mkr(v.kr / 1000)}</td></tr>`), '')}
    ${a.perKommun.length > 1 ? `<h3>Per kommun ${a.ar}</h3>
    ${table('<th>Kommun</th><th class="num">Antal</th><th class="num">Volym</th>', a.perKommun.map((k) =>
      `<tr><td>${esc(k.kommun ?? 'Okänd')}${bar(k.kr / (a.perKommun[0].kr || 1))}</td>
        <td class="num">${n(k.antal)}</td><td class="num">${mkr(k.kr / 1000)}</td></tr>`), '')}` : ''}
    <h3>Största köparna ${a.ar}</h3>
    ${table('<th>Köpare</th><th class="num">Antal</th><th class="num">Volym</th>', a.kopare.map((k) =>
      `<tr><td>${bolagLink(k.orgnr, k.namn, k.demo)}${bar(k.kr / (a.kopare[0].kr || 1))}</td>
        <td class="num">${n(k.antal)}</td><td class="num">${mkr(k.kr / 1000)}</td></tr>`), '')}
    <h3>Största transaktionerna ${a.ar}</h3>
    ${table('<th>Datum</th><th>Fastighet och köpare</th><th class="num">Pris</th>', a.storsta.map(affarRad), '')}
    <h3>Senaste transaktionerna ${a.ar}</h3>
    ${table('<th>Datum</th><th>Fastighet och köpare</th><th class="num">Pris</th>', a.senaste.map(affarRad), '')}
    ` : '<p class="empty">Inga registrerade köp ännu. Köpeskillingar läses in när Lantmäteriet har svarat.</p>'}
  `);
}

// Största fastighetsägare efter antal, tomtareal eller taxeringsvärde.
// Senaste parametrarna när området är kartutsnittet; listan räknas då om när kartan flyttas (se loadVisible).
let agareUtsnitt = null;
async function openAgare(p = {}) {
  const utsnitt = p.kommun === 'utsnitt';
  const b = map.getBounds();
  const q = utsnitt ? { ...p, kommun: '', bbox: [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()].map((x) => x.toFixed(5)).join(',') } : p;
  const [s, r] = await Promise.all([statusP, apiPanel(`/api/storsta-agare?${new URLSearchParams(q)}`)]);
  if (!r) return;
  agareUtsnitt = utsnitt ? p : null;
  select(null);
  const n = (x) => (x == null ? '–' : Math.round(x).toLocaleString('sv-SE'));
  const areal = r.efter === 'areal';   // tredje kolumnen: tomtareal, annars taxeringsvärde
  showPanel(`
    <h2>Största ägare</h2>
    <div class="meta">Juridiska personer med lagfart. Samägda fastigheter räknas fullt för varje ägare.</div>
    <form class="view-form" data-view="agare">
      ${field('Område', 'kommun', options([['utsnitt', 'I kartutsnittet'], ...(s.kommuner ?? [])], r.utsnitt ? 'utsnitt' : r.kommun, 'Alla kommuner'))}
      ${field('Användning', 'anv', options(s.typer ?? [], r.anv, 'Alla'))}
      ${field('Rangordna efter', 'efter', options([['antal', 'Antal fastigheter'], ['areal', 'Tomtareal'], ['varde', 'Taxeringsvärde']], r.efter))}
    </form>
    ${table(`<th>Ägare</th><th class="num">Antal</th><th class="num">${areal ? 'Tomtareal' : 'Värde'}</th>`, r.agare.map((a, i) =>
      `<tr><td><span class="muted small">${i + 1}.</span> ${bolagLink(a.orgnr, a.namn, a.demo)}<div class="muted small">${esc(a.jurform ?? '')}</div></td>
        <td class="num">${n(a.antal)}</td><td class="num">${areal ? `${n(a.areal_m2)} m²` : mkr(a.varde_tkr)}</td></tr>`),
      'Inga kända ägare ännu. Ägaruppgifter läses in när Lantmäteriet har svarat.')}
  `);
}

// #affarer är det gamla namnet på #transaktioner: gamla länkar och formulärets data-view.
const VIEWS = { '#om': openOm, '#transaktioner': openAffarer, '#affarer': openAffarer, '#agare': openAgare };   // och #scenario (scenario.js, se app.js)
