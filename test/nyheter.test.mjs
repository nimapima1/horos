import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lasRss, tolka } from '../lib/nyheter.mjs';

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
