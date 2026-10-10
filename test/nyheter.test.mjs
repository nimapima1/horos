import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lasRss, tolka } from '../lib/nyheter.mjs';

test('pressmeddelande om försäljning: typ, pris, kommun och beteckning', () => {
  const [n] = lasRss(`<rss><channel><item><title>Corem s&#228;ljer en fastighet i Link&#246;ping f&#246;r 160 mkr</title>
    <link>https://news.cision.com/se/corem-property-group/r/x,c1</link><description><![CDATA[<p>Avtal om försäljning av
    fastigheten Brevduvan 21 i centrala Linköping. Cirka 9 600 kvm.</p>]]></description>
    <pubDate>Mon, 07 Sep 2026 06:00:00 GMT</pubDate></item></channel></rss>`);
  assert.equal(n.rubrik, 'Corem säljer en fastighet i Linköping för 160 mkr');
  assert.equal(n.datum, '2026-09-07T06:00:00.000Z');
  assert.deepEqual(tolka(n), { typ: 'salj', pris_kr: 160e6, kommun: 'Linköping', beteckningar: ['LINKÖPING BREVDUVAN 21'], adresser: [] });
});

test('köp med adress och pris i miljarder; kommunen före trakten tas bort', () => {
  const n = tolka({ rubrik: 'Vasakronan förvärvar på Vasagatan 12 i Stockholm', text: 'Fastigheten Stockholm Uggleborg 14 köps för 1,2 mdkr. Säljare är en privatperson.' });
  assert.equal(n.pris_kr, 1.2e9);
  assert.deepEqual(n.adresser, [{ gata: 'Vasagatan', nummer: '12' }]);
  assert.deepEqual(n.beteckningar, ['STOCKHOLM UGGLEBORG 14']);
});

test('inte affärer: uthyrning, rapporter, utlandet och försäljning till privatperson', () => {
  for (const rubrik of ['Vasakronan hyr ut 3000 kvm i Malmö', 'Delårsrapport: Corem säljer mer', 'Skanska säljer kontor i Warszawa för EUR 98M',
    'Peab säljer fastighet i Solna till en privatperson', 'Vasakronan köper kontor för EUR 50M'])
    assert.equal(tolka({ rubrik, text: '' }), null, rubrik);
});

test('en svensk affär med priset även i euro räknas', () => {
  assert.equal(tolka({ rubrik: 'Slättö förvärvar 40 % av en portfölj i Uppsala värderad till 3,1 miljarder SEK (270 miljoner EUR)', text: '' }).typ, 'kop');
});

test('priset är köpeskillingen, inte hyresvärdet', () => {
  for (const text of ['Hyresvärdet uppgår till 12 mkr. Köpeskillingen är 300 mkr.', 'Ett hyresvärde om 1 200 mkr och köpeskilling 300 mkr.'])
    assert.equal(tolka({ rubrik: 'Vasakronan köper i Uppsala', text }).pris_kr, 300e6, text);
});
