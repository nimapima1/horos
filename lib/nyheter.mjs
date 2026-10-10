// Pressmeddelanden om fastighetsaffärer: RSS-tolkning och utläsning av typ, pris, kommun,
// fastighetsbeteckningar och adresser. Bara fakta sparas (aldrig texten), se import-nyheter.
import { KOMMUNER } from './kommuner.mjs';
import { normBeteckning } from './db.mjs';

// Fastighetsbolagens nyhetsrum på Cision (news.cision.com/se/<namn>), vars robots.txt tillåter hämtning.
// MFN (där de flesta noterade bolagen finns) förbjuder automatisk hämtning av flödena: tas med först
// när Modular Finance har gett tillstånd.
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

const ENTITETER = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
const text = (s) => s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<[^>]+>/g, ' ')
  .replace(/&(#\d+|\w+);/g, (m, e) => (e[0] === '#' ? String.fromCodePoint(+e.slice(1)) : ENTITETER[e] ?? m))
  .replace(/\s+/g, ' ').trim();

// RSS 2.0 -> [{ rubrik, url, text, datum (ISO) }].
export function lasRss(xml) {
  return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map(([, it]) => {
    const f = (tag) => text(it.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`))?.[1] ?? '');
    const d = new Date(f('pubDate'));
    return { rubrik: f('title'), url: f('link'), text: f('description'), datum: Number.isNaN(+d) ? null : d.toISOString() };
  });
}

const KOP = /förvärv|köper|köpt/i, SALJ = /säljer|sålt|avyttr|försälj/i;
const INTE_AFFAR = /aktie|obligation|emission|återköp|utdelning|rapport|kallelse|bokslut|stämma|affärsområde|startar försäljning|säljstart/i;
// Affärer utomlands: Horos gäller Sverige.
// En utländsk valuta räknas bara när rubriken saknar kronor ("3,1 miljarder SEK (270 miljoner EUR)" är svensk).
const UTLAND = /Finland|Norge|Danmark|Tyskland|Polen|Ungern|Tjeckien|Storbritannien|USA|Helsingfors|Oslo|New York|London|Köpenhamn|Warszawa|Budapest|Prag/;
const utlandsk = (rubrik) => UTLAND.test(rubrik) || (/\b(EUR|USD|NOK|DKK)\b/.test(rubrik) && !/\bSEK\b|kronor|\bmd?kr\b/i.test(rubrik));
// Säljs fastigheten till en privatperson får den inte visas (bara juridiska personer äger fastigheterna i Horos).
const TILL_PRIVAT = /till (en )?privat(person|a)?|privat köpare|fysisk person/i;
const BELOPP = /(\d+(?:[ ,.]\d+)*)\s*(mdkr|miljarder kronor|mkr|msek|mnkr|miljoner kronor)/i;
// I brödtexten: inte hyresvärdet eller driftnettot, som ofta står före köpeskillingen.
const BELOPP_TEXT = new RegExp(String.raw`(?<!\d[ ,.]?)(?<!(?:hyresvärde|hyresintäkt|driftnetto)\D{0,15})` + BELOPP.source, 'i');
const GATA = /\b([A-ZÅÄÖ][a-zåäöéü]+(?:gatan|vägen|väg|gata|gränd|torget|torg|backe|allé|stigen|leden|kajen|strand|esplanaden))\s+(\d{1,3}[A-Z]?)\b/g;
// Trakt (ett eller två ord) och block/enhet: "Brevduvan 21", "Sicklaön 83:22", "Stora Frösunda 2", men inte
// ytor och belopp ("cirka 9 600 kvm").
const TRAKT = /\b((?:[A-ZÅÄÖ][a-zåäöéü]+ )?[A-ZÅÄÖ][a-zåäöéü]+) (\d{1,3}(?::\d{1,4})?)\b(?! \d)(?!\s*(?:kvm|mkr|procent|%|år|st))/g;
const KOMMUN_NAMN = new Set(KOMMUNER.map(([, n]) => n));
const KOMMUN_RE = new RegExp(`(?<![\\wåäö])(${KOMMUNER.map(([, n]) => n).sort((a, b) => b.length - a.length).join('|')})(?![\\wåäö])`, 'g');

// En affär ur ett pressmeddelande, eller null om det inte gäller köp eller försäljning av fastigheter.
// beteckningar är kandidater (kommun + trakt) som slås upp mot fastighetstabellen när den finns.
export function tolka({ rubrik, text: brodtext }) {
  const typ = KOP.test(rubrik) ? 'kop' : SALJ.test(rubrik) ? 'salj' : null;
  const allt = `${rubrik}. ${brodtext}`;
  if (!typ || INTE_AFFAR.test(rubrik) || utlandsk(rubrik) || TILL_PRIVAT.test(allt)) return null;
  const b = rubrik.match(BELOPP) ?? brodtext.match(BELOPP_TEXT);
  const pris_kr = b ? Math.round(Number(b[1].replace(/ /g, '').replace(',', '.')) * (/^(mdkr|miljarder)/i.test(b[2]) ? 1e9 : 1e6)) : null;
  // Kommunen i rubriken i första hand: brödtexten slutar ofta med en lista över bolagets orter.
  const iRubrik = [...rubrik.matchAll(KOMMUN_RE)].map((m) => m[1]);
  const kommuner = [...new Set(iRubrik.length ? iRubrik : [...allt.matchAll(KOMMUN_RE)].map((m) => m[1]))];
  const adresser = [...new Map([...allt.matchAll(GATA)].map(([, gata, nr]) => [`${gata} ${nr}`, { gata, nummer: nr }])).values()];
  const gator = new Set(adresser.map((a) => a.gata));
  // Två ord kan vara ett ord före trakten ("Fastigheten Brevduvan 21"): pröva även det sista ordet.
  const trakter = [...new Set([...allt.matchAll(TRAKT)].filter(([, t]) => !gator.has(t) && !kommuner.includes(t))
    .flatMap(([, t, nr]) => [...(KOMMUN_NAMN.has(t.split(' ')[0]) ? [] : [`${t} ${nr}`]), `${t.split(' ').pop()} ${nr}`]))];
  const beteckningar = kommuner.flatMap((k) => trakter.map((t) => normBeteckning(`${k} ${t}`)));
  return { typ, pris_kr, kommun: kommuner[0] ?? null, beteckningar, adresser };
}
