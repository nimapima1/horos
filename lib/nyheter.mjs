// Pressmeddelanden om fastighetsaffärer: RSS-tolkning och utläsning av typ, pris, kommun,
// fastighetsbeteckningar och adresser. Bara fakta sparas (aldrig texten), se import-nyheter.
import { KOMMUNER, kommunAv } from './kommuner.mjs';
import { normBeteckning, normOrgnr } from './db.mjs';

// Fastighetsbolagens nyhetsrum på Cision (news.cision.com/se/<namn>), vars robots.txt tillåter hämtning.
// Branschtidningar med ett öppet flöde (rubrik, länk, datum) och utan förbehåll mot insamling:
// [källa, namn, flöde, länkar som räknas]. Fastighetsvärlden (Tidnings AB Fastighetsvärlden): sitemap.rss pekas ut i
// robots.txt, redaktionen meddelad 2026-10-15. Bonnier News (Fastighetsnytt, Di) förbjuder insamling utan tillstånd.
export const TIDNINGAR = [
  ['fastighetsvarlden', 'Fastighetsvärlden', 'https://www.fastighetsvarlden.se/sitemap.rss', 'https://www.fastighetsvarlden.se/notiser/'],
];
// En tidningsrubrik har ingen avsändare; den som köper eller säljer står först ("Emilshus köper nio för 341 mkr").
export const aktorIRubrik = (rubrik) => {
  const m = rubrik.match(/\s(köper|köpt|förvärvar|förvärvat|säljer|sålt|avyttrar)(?![\wåäö])/i);
  return m ? rubrik.slice(0, m.index).trim() || null : null;
};

// MFN förbjuder automatisk hämtning av flödena, men skickar i stället alla sina pressmeddelanden till
// /api/mfn (se tolkaMfn nedan).
export const CISION = [
  ['vasakronan', 'Vasakronan'],
  ['corem-property-group', 'Corem Property Group'],
  ['klovern', 'Klövern'],
  ['rikshem', 'Rikshem'],
  ['willhem', 'Willhem'],
  ['stockholmshem', 'Stockholmshem'],
  ['amf-fastigheter', 'AMF Fastigheter'],
  ['svenska-handelsfastigheter', 'Svenska Handelsfastigheter'],
  ['alm-equity', 'ALM Equity'],
  ['fastighets-ab-trianon', 'Fastighets AB Trianon'],
  ['slatto', 'Slättö'],
  ['ncc', 'NCC'],
  ['skanska', 'Skanska'],
  ['peab', 'Peab'],
];

const ENTITETER = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ensp: ' ', emsp: ' ', thinsp: ' ',
  aring: 'å', Aring: 'Å', auml: 'ä', Auml: 'Ä', ouml: 'ö', Ouml: 'Ö', eacute: 'é', Eacute: 'É' };
const text = (s) => s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
  .replace(/&(#x[\da-f]+|#\d+|\w+);/gi, (m, e) => {
    if (e[0] !== '#') return ENTITETER[e] ?? ENTITETER[e.toLowerCase()] ?? m;
    const n = /^#x/i.test(e) ? parseInt(e.slice(2), 16) : +e.slice(1);
    return n <= 0x10FFFF ? String.fromCodePoint(n) : m;
  })
  .replace(/<\/?(?:p|div|br|li|h[1-6]|tr|td|section|article)\b[^>]*>/gi, ' ')
  .replace(/<[^>]+>/g, '')
  .replace(/\s+/g, ' ').trim();

// Publik rubrik byggs enbart av fakta och ett verifierat bolagsnamn. I en tidning är bolaget den som köper
// eller säljer (aktor_orgnr), inte avsändaren: "Fastighetsköp av X", aldrig "X meddelar".
export const arTidning = (kalla) => TIDNINGAR.some(([k]) => k === kalla);
export function nyhetsRubrik(n, bolag = null) {
  const namn = bolag ?? (CISION.some(([, b]) => b === n.utgivare) ? n.utgivare : null);
  const typ = n.typ === 'kop' ? 'Fastighetsköp' : 'Fastighetsförsäljning';
  const kommun = kommunAv(n.kommun);
  return (!namn ? typ : arTidning(n.kalla) ? `${typ} av ${namn}` : `${namn} meddelar ${typ.toLowerCase()}`)
    + (kommun ? ` i ${kommun}` : '')
    + (n.pris_kr != null ? ` för ${Number(n.pris_kr).toLocaleString('sv-SE')} kr` : '');
}

// Namnet först i en tidningsrubrik -> det registrerade bolaget, bara när namnet är exakt bolagets (med eller
// utan "AB"/"AB (publ)") och bara ett bolag heter så. Annars null: hellre ingen än fel aktör eller en privatperson.
export function aktorBolag(db) {
  const q = db.prepare("SELECT orgnr, namn FROM bolag WHERE namn IN (?, ? || ' AB', ? || ' AB (publ)')");
  return (namn) => {
    const r = namn ? q.all(namn, namn, namn).filter((b) => normOrgnr(b.orgnr)) : [];
    return r.length === 1 ? r[0] : null;
  };
}

export function publiceraNyheter(db) {
  const bolag = db.prepare('SELECT orgnr, namn FROM bolag WHERE namn = ?');
  const bolagOrg = db.prepare('SELECT orgnr, namn FROM bolag WHERE orgnr = ?');
  const ins = db.prepare('UPDATE nyhet SET rubrik = ? WHERE url = ?');
  for (const n of db.prepare('SELECT * FROM nyhet').iterate()) {
    // En tidning är källan, inte köparen eller säljaren: bolaget är aktören i rubriken, om den är känd.
    const b = arTidning(n.kalla) ? (n.aktor_orgnr ? bolagOrg.get(n.aktor_orgnr) : null) : bolag.get(n.utgivare);
    ins.run(nyhetsRubrik(n, normOrgnr(b?.orgnr) ? b.namn : null), n.url);
  }
}

// RSS 2.0 -> [{ rubrik, url, text, datum (ISO) }].
export function lasRss(xml) {
  return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map(([, it]) => {
    const f = (tag) => text(it.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`))?.[1] ?? '');
    const d = new Date(f('pubDate'));
    return { rubrik: f('title'), url: f('link'), text: f('description'), datum: Number.isNaN(+d) ? null : d.toISOString() };
  });
}

const KOP = /förvärv|köper|köpt/i, SALJ = /säljer|sålt|avyttr|försälj/i;
const INTE_AFFAR = /rapport|kallelse|bokslut|stämma|flaggning|affärsområde|startar försäljning|säljstart/i;
// Aktier och andra värdepapper är bara en fastighetsaffär om rubriken också talar om fastigheter eller ett
// belopp ("Trianon säljer samtliga aktier i Stjernplan och … förvärv av 500 lägenheter").
const VARDEPAPPER = /aktie|obligation|emission|återköp|utdelning/i;
const FASTIGHETSORD = /\b(fastighet|fastigheten|fastigheter|fastigheterna|lägenheter|bostäder)\b|\d\s*(mkr|mdkr)\b/i;
// Affärer utomlands: Horos gäller Sverige. Hela ord, så att gator i Kista (Finlandsgatan, Oslogatan) inte räknas.
const UTLAND = /(?<![\wåäö])(Finland|Norge|Danmark|Tyskland|Polen|Ungern|Tjeckien|Rumänien|Estland|Lettland|Litauen|Storbritannien|USA|Helsingfors|Oslo|New York|London|Köpenhamn|Warszawa|Budapest|Bukarest|Prag)(?![\wåäö])/;
// Valutan som nämns först avgör: "3,1 miljarder SEK (270 miljoner EUR)" är svensk, "EUR 80M, cirka 900 miljoner kronor" inte.
const VALUTA = /\b(EUR|USD|NOK|DKK)\b/, KRONOR = /\b(M?SEK|md?kr)\b|kronor/i;
const utlandsk = (rubrik) => {
  const v = rubrik.search(VALUTA), k = rubrik.search(KRONOR);
  return UTLAND.test(rubrik) || (v >= 0 && (k < 0 || v < k));
};
// Köper en privatperson får fastigheten inte visas (bara juridiska personer äger fastigheterna i Horos).
// En privatperson som säljer till ett bolag går bra: då står personen bara som säljare.
const TILL_PRIVAT = /(köpare|förvärvare)n? är en (privatperson|fysisk person)|till (en )?privatperson|privat köpare/i;
const BELOPP = /(\d+(?:[ ,.]\d+)*)\s*(mdkr|miljarder kronor|mkr|msek|mnkr|miljoner kronor)/i;
// I brödtexten: inte hyran eller driftnettot, som ofta står före köpeskillingen ("Hyresvärdet uppgår till
// cirka 12 mkr"), eller bolagets samlade värden. Siffror emellan bryter sökningen bakåt.
const BELOPP_TEXT = new RegExp(String.raw`(?<!\d[ ,.]?)(?<!(?:hyresvärde|hyresintäkt|hyran|hyra|driftnetto|(?:samlat|samlade|totalt|totala|förvaltat|förvaltade) fastighetsvärde|portföljvärde|(?:bolagets|koncernens|vår[ta]?) (?:totala |samlade |förvaltade )?(?:fastighets)?(?:portfölj|bestånd)|förvaltar en (?:fastighets)?portfölj)\D{0,40})` + BELOPP.source, 'i');
// Ordgräns som också gäller å, ä och ö (\b gör det inte i JavaScript).
const ORDSTART = '(?<![\\wåäöÅÄÖéü])';
const GATA = new RegExp(String.raw`${ORDSTART}([A-ZÅÄÖ][a-zåäöéü]+(?:gatan|vägen|väg|gata|gränd|torget|torg|backe|allé|stigen|leden|kajen|strand|esplanaden))\s+(\d{1,3}[A-Z]?)\b`, 'g');
// Trakt (ett eller två ord) och block/enhet: "Brevduvan 21", "Sicklaön 83:22", "Stora Frösunda 2", men inte
// ytor och belopp ("cirka 9 600 kvm").
const TRAKT = new RegExp(String.raw`${ORDSTART}((?:[A-ZÅÄÖ][a-zåäöéü]+ )?[A-ZÅÄÖ][a-zåäöéü]+) (\d{1,3}(?::\d{1,4})?)\b(?! \d)(?!\s*(?:kvm|mkr|procent|%|år|st)(?![\wåäö]))`, 'g');
const KOMMUN_NAMN = new Set(KOMMUNER.map(([, n]) => n));
const KOMMUN_RE = new RegExp(`(?<![\\wåäö])(${KOMMUNER.map(([, n]) => n).sort((a, b) => b.length - a.length).join('|')})(?![\\wåäö])`, 'g');
// Kommunnamn i texten, utom efternamn som också är kommuner ("säger Anna Berg." / "Anna Lund, vd").
const kommunerI = (s) => [...s.matchAll(KOMMUN_RE)]
  .filter((m) => !(/[A-ZÅÄÖ][a-zåäöé]+ $/.test(s.slice(0, m.index)) && /^[,.]/.test(s.slice(m.index + m[1].length))))
  .map((m) => m[1]);

// En affär ur ett pressmeddelande, eller null om det inte gäller köp eller försäljning av fastigheter.
// beteckningar är kandidater (kommun + trakt) som slås upp mot fastighetstabellen när den finns.
export function tolka({ rubrik, text: brodtext }) {
  rubrik = text(rubrik); brodtext = text(brodtext ?? '');
  const typ = KOP.test(rubrik) ? 'kop' : SALJ.test(rubrik) ? 'salj' : null;
  const allt = `${rubrik}. ${brodtext}`;
  if (!typ || INTE_AFFAR.test(rubrik) || (VARDEPAPPER.test(rubrik) && !FASTIGHETSORD.test(rubrik))
    || utlandsk(rubrik) || TILL_PRIVAT.test(allt)) return null;
  const b = rubrik.match(BELOPP) ?? brodtext.match(BELOPP_TEXT);
  const pris_kr = b ? Math.round(Number(b[1].replace(/ /g, '').replace(',', '.')) * (/^(mdkr|miljarder)/i.test(b[2]) ? 1e9 : 1e6)) : null;
  // Kommunen i rubriken i första hand: brödtexten slutar ofta med en lista över bolagets orter.
  const iRubrik = kommunerI(rubrik);
  const kommuner = [...new Set(iRubrik.length ? iRubrik : kommunerI(allt))];
  const adresser = [...new Map([...allt.matchAll(GATA)].map(([, gata, nr]) => [`${gata} ${nr}`, { gata, nummer: nr }])).values()];
  const gator = new Set(adresser.map((a) => a.gata));
  // Två ord kan vara ett ord före trakten ("Fastigheten Brevduvan 21"): pröva även det sista ordet.
  const trakter = [...new Set([...allt.matchAll(TRAKT)].filter(([, t]) => !gator.has(t) && !kommuner.includes(t))
    .flatMap(([, t, nr]) => [...(KOMMUN_NAMN.has(t.split(' ')[0]) ? [] : [`${t} ${nr}`]), `${t.split(' ').pop()} ${nr}`]))];
  const beteckningar = kommuner.flatMap((k) => trakter.map((t) => normBeteckning(`${k} ${t}`)));
  return { typ, pris_kr, kommun: kommuner[0] ?? null, beteckningar, adresser };
}

// Ett pressmeddelande som MFN skickar (News Item, https://modfin.gitbook.io/mfn): köp eller försäljning med
// länken till MFN:s sida, annars null. Bara svenska (reglerna ovan är svenska; den engelska versionen av samma
// pressmeddelande vore en dubblett). Texten används bara här och sparas aldrig.
export function tolkaMfn(item) {
  const c = item?.content, d = new Date(c?.publish_date);
  if (item?.properties?.lang !== 'sv' || typeof c?.title !== 'string' || !/^https:\/\//.test(item.url ?? '')) return null;
  const t = tolka({ rubrik: c.title, text: typeof c.text === 'string' ? c.text : '' });
  // Utgivarens org.nr: MFN anger svenska bolag som "SE:556475-5550" (local_refs, i dokumentationen local_ref).
  const ref = [item.author?.local_refs, item.author?.local_ref].flat().find((r) => typeof r === 'string' && r.startsWith('SE:'));
  return t && { url: item.url, utgivare: item.author?.name ?? 'MFN', orgnr: normOrgnr(ref?.slice(3)), rubrik: c.title,
    datum: Number.isNaN(+d) ? null : d.toISOString(), ...t };
}

// MFN skickar alla bolags pressmeddelanden; bara fastighetsbolagens köp och försäljningar tas med (annars blir
// "X förvärvar konsultbolaget Y" en affär). Fastighetsbolag: SNI 68 (fastighetsverksamhet) eller ett namn som
// säger det, i bolagsregistret (bolag) eller hos MFN; därtill moderbolag som är registrerade som huvudkontor
// eller holding (SNI 70100/64xxx) och inte heter något med fastighet.
// shortcut: listan är för hand (2026-10-12); lägg till org.nr när ett fastighetsbolags affär saknas.
export const MFN_FASTIGHETSBOLAG = new Set([
  '5564755550',   // Castellum
  '5565200028',   // Sagax
  '5569817660',   // Samhällsbyggnadsbolaget i Norden (SBB)
  '5560307885',   // Pandox
  '5568270390',   // K-Fast Holding
  '5566937404',   // Eastnine
  '5566700455',   // Heimstaden
  '5568874274',   // Titania Holding
]);
const FASTIGHETSNAMN = /fastighet|bostad|property|properties|real estate/i;
export const arFastighetsbolag = (orgnr, bolag, namnHosMfn = '') => !!orgnr && (MFN_FASTIGHETSBOLAG.has(orgnr)
  || /^68/.test(bolag?.sni ?? '') || FASTIGHETSNAMN.test(`${bolag?.namn ?? ''} ${namnHosMfn}`));
