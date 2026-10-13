import { test } from 'node:test';
import assert from 'node:assert/strict';
import { arFastighetsbolag, lasRss, tolka, tolkaMfn } from '../lib/nyheter.mjs';

const t = (rubrik, text = '') => tolka({ rubrik, text });

test('pressmeddelande om försäljning: typ, pris, kommun och beteckning', () => {
  const [n] = lasRss(`<rss><channel><item><title>Corem s&#228;ljer en fastighet i Link&#246;ping f&#246;r 160 mkr</title>
    <link>https://news.cision.com/se/corem-property-group/r/x,c1</link><description><![CDATA[<p>Avtal om försäljning av
    fastigheten Brevduvan 21 i centrala Linköping. Cirka 9 600 kvm.</p>]]></description>
    <pubDate>Mon, 07 Sep 2026 06:00:00 GMT</pubDate></item></channel></rss>`);
  assert.equal(n.rubrik, 'Corem säljer en fastighet i Linköping för 160 mkr');
  assert.equal(n.datum, '2026-09-07T06:00:00.000Z');
  assert.deepEqual(tolka(n), { typ: 'salj', pris_kr: 160e6, kommun: 'Linköping', beteckningar: ['LINKÖPING BREVDUVAN 21'], adresser: [] });
});

test('en trasig teckenreferens stoppar inte inläsningen', () => {
  assert.equal(lasRss('<item><title>A &#99999999; köper</title></item>')[0].rubrik, 'A &#99999999; köper');
});

test('köp med adress och pris i miljarder; kommunen före trakten tas bort', () => {
  const n = t('Vasakronan förvärvar på Vasagatan 12 i Stockholm', 'Fastigheten Stockholm Uggleborg 14 köps för 1,2 mdkr. Säljare är en privatperson.');
  assert.equal(n.pris_kr, 1.2e9);
  assert.deepEqual(n.adresser, [{ gata: 'Vasagatan', nummer: '12' }]);
  assert.deepEqual(n.beteckningar, ['STOCKHOLM UGGLEBORG 14']);
});

test('gator och trakter som börjar på Å, Ä eller Ö', () => {
  const n = t('Vasakronan köper på Östermalmsgatan 12 i Stockholm', 'Fastigheterna Ödlan 3 och Ärlan 5 strax intill.');
  assert.deepEqual(n.adresser, [{ gata: 'Östermalmsgatan', nummer: '12' }]);
  for (const b of ['STOCKHOLM ÖDLAN 3', 'STOCKHOLM ÄRLAN 5']) assert.ok(n.beteckningar.includes(b), b);
});

test('inte affärer: uthyrning, rapporter, värdepapper, utlandet och försäljning till privatperson', () => {
  for (const rubrik of ['Vasakronan hyr ut 3000 kvm i Malmö', 'Delårsrapport: Corem säljer mer', 'Skanska säljer kontor i Warszawa för EUR 98M',
    'Peab säljer fastighet i Solna till en privatperson', 'Vasakronan köper kontor för EUR 50M',
    'Skanska säljer kontorsprojekt i Bukarest, Rumänien, för EUR 80M, cirka 900 miljoner kronor',
    'ALM Equitys nytillträdde VD köper aktier för nästan 1 miljon kronor', 'AP4 och Kåpan slutför aktieförvärv i Svenska Handelsfastigheter'])
    assert.equal(t(rubrik), null, rubrik);
  assert.equal(t('Peab säljer fastighet i Solna', 'Köparen är en privatperson.'), null);
});

test('affärer som ändå räknas', () => {
  for (const [rubrik, text] of [
    ['Slättö förvärvar 40 % av en portfölj i Uppsala värderad till 3,1 miljarder SEK (270 miljoner EUR)', ''],
    ['Vasakronan säljer Finlandsgatan 10 i Kista, Stockholm', ''],
    ['Trianon säljer samtliga aktier i Stjernplan och tecknar avtal om förvärv av 500 lägenheter i Ystad och Skurup', ''],
    ['Vasakronan förvärvar fastighet i Uppsala', 'Säljare är en fysisk person.'],
    ['Rikshem förvärvar samhällsfastighet i Mölndal', 'Fastigheten hyrs ut till privata vårdgivare.'],
  ]) assert.ok(t(rubrik, text), rubrik);
});

test('priset är köpeskillingen, inte hyran', () => {
  for (const text of ['Hyresvärdet uppgår till 12 mkr. Köpeskillingen är 300 mkr.', 'Ett hyresvärde om 1 200 mkr och köpeskilling 300 mkr.',
    'Det årliga hyresvärdet uppgår till cirka 12 mkr. Köpeskillingen är 300 mkr.'])
    assert.equal(t('Vasakronan köper i Uppsala', text).pris_kr, 300e6, text);
});

test('ett efternamn som också är en kommun räknas inte som kommun', () => {
  assert.equal(t('Klövern förvärvar fastighet', 'Fastigheten Pilen 1 köps, säger Anna Berg. Den ligger i Uppsala.').kommun, 'Uppsala');
});

test('MFN: svenskt pressmeddelande om köp tolkas, engelska och andra hoppas över', () => {
  const item = (lang, title, text = '') => ({ url: 'https://mfn.se/a/alfa/alfa-koper', author: { name: 'Alfa AB', local_refs: ['SE:556000-0001'] },
    properties: { lang, type: 'ir' }, content: { title, text, publish_date: '2026-10-12T08:00:00+02:00' } });
  assert.deepEqual(tolkaMfn(item('sv', 'Alfa förvärvar fastighet i Linköping för 160 mkr', 'Avtal om fastigheten Brevduvan 21.')), {
    url: 'https://mfn.se/a/alfa/alfa-koper', utgivare: 'Alfa AB', orgnr: '5560000001', rubrik: 'Alfa förvärvar fastighet i Linköping för 160 mkr',
    datum: '2026-10-12T06:00:00.000Z', typ: 'kop', pris_kr: 160e6, kommun: 'Linköping', beteckningar: ['LINKÖPING BREVDUVAN 21'], adresser: [] });
  assert.equal(tolkaMfn(item('en', 'Alfa acquires property in Linköping')), null);
  assert.equal(tolkaMfn(item('sv', 'Alfa publicerar delårsrapport')), null);
  assert.equal(tolkaMfn({ ...item('sv', 'Alfa förvärvar fastighet'), url: 'javascript:alert(1)' }), null);
  assert.equal(tolkaMfn(null), null);
});

test('MFN: bara fastighetsbolag (SNI 68, namnet eller listan över moderbolag)', () => {
  assert.equal(arFastighetsbolag('5560000001', { namn: 'Alfa AB', sni: '68203' }), true);
  assert.equal(arFastighetsbolag('5560000001', { namn: 'Alfa Fastigheter Holding AB', sni: '70100' }), true);
  assert.equal(arFastighetsbolag('5560000001', undefined, 'Beta Property Group'), true);   // bara MFN:s namn
  assert.equal(arFastighetsbolag('5564755550', { namn: 'Castellum Aktiebolag', sni: '70100' }), true);   // på listan
  assert.equal(arFastighetsbolag('5560000001', { namn: 'Konsult AB', sni: '70220' }, 'Konsult AB'), false);
  assert.equal(arFastighetsbolag(null, { namn: 'X Fastigheter AB', sni: '68203' }), false);   // utan svenskt org.nr
});

test('gemensam tolkning avkodar MFN:s HTML före kontrollen av privata köpare', () => {
  const item = { url: 'https://mfn.se/a/alfa/privat', properties: { lang: 'sv' },
    author: { name: 'Alfa AB', local_refs: ['SE:5560000001'] },
    content: { title: 'Alfa säljer fastighet i Uppsala' } };
  for (const text of ['Köparen är en <strong>privatperson</strong>.', 'Köparen&nbsp;är&nbsp;en&nbsp;privatperson.',
    'Köparen&#160;är&#32;en&#xA0;privatperson.', 'K&ouml;paren &auml;r en privat<strong>person</strong>.', '&lt;p&gt;Köparen är en privatperson.&lt;/p&gt;']) {
    assert.equal(tolkaMfn({ ...item, content: { ...item.content, text } }), null, text);
  }
  const n = tolkaMfn({ ...item, content: { title: '<b>Alfa köper</b> i Uppsala för 10&nbsp;mkr', text: 'Säljaren är en <strong>privatperson</strong>.' } });
  assert.equal(n.typ, 'kop'); assert.equal(n.pris_kr, 10000000); assert.equal(n.kommun, 'Uppsala');
});

test('Halmstad 2026-09-02: bolagets samlade fastighetsvärde är inte affärspriset', () => {
  // https://news.cision.com/se/svenska-handelsfastigheter/r/svenska-handelsfastigheter-forvarvar-i-halmstad,c4390615
  const rubrik = 'SVENSKA HANDELSFASTIGHETER FÖRVÄRVAR I HALMSTAD';
  const text = 'Därmed spränger bolaget gränsen till ett samlat fastighetsvärde om 25 miljarder kronor.';
  assert.equal(t(rubrik, text).pris_kr, null);
  assert.equal(tolkaMfn({ url: 'https://mfn.se/a/shf/halmstad', properties: { lang: 'sv' },
    content: { title: rubrik, text } }).pris_kr, null);
});

test('prisregression: rubrikens pris och första tillåtna belopp behålls', () => {
  for (const [rubrik, text, pris] of [
    ['Skanska avyttrar byggrätter i Skarplöt, Västerhaninge, för 290 miljoner kronor', '', 290e6],
    ['Corem säljer 14 fastigheter för cirka 1 200 mkr', '', 1200e6],
    ['Alfa förvärvar fastighet', 'Köpeskillingen uppgår till cirka 300 MSEK.', 300e6],
    ['Alfa förvärvar fastighet', 'Köpeskillingen är 300 mnkr.', 300e6],
    ['Alfa förvärvar fastighet', 'Köpeskillingen är 2,5 miljarder kronor.', 2.5e9],
    ['Alfa förvärvar fastighet', 'Fastigheten omfattar ca 25 000 kvm. Tillträde sker 2026. Köpeskillingen är 300 mkr.', 300e6],
    ['Alfa förvärvar fastighet', 'Ett överenskommet fastighetsvärde om 1 062 mkr. Köpeskillingen för aktierna är 70 mkr.', 1062e6],
    ['Trianon avyttrar fastigheter med ett fastighetsvärde om 1 062 Mkr', 'En preliminär kontant köpeskilling om cirka 70 Mkr.', 1062e6],
    ['Alfa köper en portfölj för 300 mkr', '', 300e6],
    ['Alfa köper fastigheter', 'En portfölj förvärvas till ett fastighetsvärde om 300 mkr.', 300e6],
    ['Alfa förvärvar fastighet för 300 mkr', 'Bolagets samlade fastighetsvärde uppgår till 25 miljarder kronor.', 300e6],
    ['Alfa förvärvar fastighet', 'Köpeskillingen är 100 mkr. Köpeskillingen för aktierna är 70 mkr.', 100e6],
  ]) {
    assert.equal(t(rubrik, text).pris_kr, pris, rubrik);
    assert.equal(tolkaMfn({ url: 'https://mfn.se/a/alfa/kop', properties: { lang: 'sv' },
      content: { title: rubrik, text } }).pris_kr, pris, rubrik);
  }
});

test('bolagets samlade värden är inte affärspriser; ett senare pris får fortfarande läsas', () => {
  for (const text of [
    'Bolagets samlade fastighetsvärde är 25 miljarder kronor.',
    'Bolagets totala fastighetsvärde uppgår till cirka 2,5 miljarder kronor.',
    'Ett förvaltat fastighetsvärde om 25 miljarder kronor.',
    'Bolaget förvaltar en portfölj om 25 000 MSEK.',
    'Bolagets totala fastighetsportfölj är värd 25 miljarder kronor.',
    'Koncernens fastighetsbestånd är värt 25 miljarder kronor.',
    'Vårt fastighetsbestånd värderas till 25 miljarder kronor.',
    'Bolagets portföljvärde uppgår till 25 miljarder kronor.',
  ]) {
    assert.equal(t('Alfa köper fastighet', text).pris_kr, null, text);
    assert.equal(t('Alfa köper fastighet', text + ' Köpeskillingen är 300 mkr.').pris_kr, 300e6, text);
    assert.equal(tolkaMfn({ url: 'https://mfn.se/a/alfa/kop', properties: { lang: 'sv' },
      content: { title: 'Alfa köper fastighet', text } }).pris_kr, null, text);
  }
});
