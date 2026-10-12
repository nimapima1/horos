// Inläsning av fastigheter från en Excel- (.xlsx) eller CSV-fil till ett nytt scenario. Filen läses i webbläsaren och
// skickas aldrig till servern; bara beteckningar, adresser och kommuner skickas för att hitta fastigheterna
// (POST /api/matcha). Bara deklarationer; scenario.js använder dem och testerna i test/inlasning.test.mjs.

// Rader (listor av text) ur en CSV: semikolon, tabb eller komma (det som finns flest av på första raden),
// citattecken som Excel skriver dem.
function lasCsv(text) {
  text = text.replace(/^﻿/, '');
  const forsta = text.split(/\r?\n/, 1)[0];
  const sep = [';', '\t', ','].reduce((bast, t) => (forsta.split(t).length > forsta.split(bast).length ? t : bast));
  const rader = [];
  let rad = [], cell = '', citat = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (citat) {
      if (c !== '"') cell += c;
      else if (text[i + 1] === '"') { cell += '"'; i++; } else citat = false;
    } else if (c === '"') citat = true;
    else if (c === sep) { rad.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      rad.push(cell); rader.push(rad); rad = []; cell = '';
    } else cell += c;
  }
  if (cell || rad.length) { rad.push(cell); rader.push(rad); }
  return rader;
}

// Filerna i en zip (en .xlsx är en zip med XML): namn -> innehåll, uppackat med webbläsarens inbyggda deflate.
// shortcut: inte zip64, så filer över 4 GB eller med över 65 535 delar läses inte; Excelfiler med fastigheter är små.
async function packaUppZip(buf) {
  const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let slut = buf.length - 22;
  while (slut >= 0 && v.getUint32(slut, true) !== 0x06054b50) slut--;
  if (slut < 0) throw new Error('Filen är inte en Excelfil (.xlsx) eller CSV.');
  const filer = {};
  let p = v.getUint32(slut + 16, true);
  for (let n = v.getUint16(slut + 10, true); n > 0; n--) {
    const metod = v.getUint16(p + 10, true), storlek = v.getUint32(p + 20, true), namnLangd = v.getUint16(p + 28, true);
    const lokal = v.getUint32(p + 42, true), namn = new TextDecoder().decode(buf.subarray(p + 46, p + 46 + namnLangd));
    const start = lokal + 30 + v.getUint16(lokal + 26, true) + v.getUint16(lokal + 28, true), data = buf.subarray(start, start + storlek);
    filer[namn] = metod === 0 ? data : metod === 8
      ? new Uint8Array(await new Response(new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer()) : null;
    p += 46 + namnLangd + v.getUint16(p + 30, true) + v.getUint16(p + 32, true);
  }
  return filer;
}

// Raderna i arbetsbokens första blad. Celler med delad text (t="s"), egen text (inlineStr) eller värden; kolumnen
// tas ur cellens adress ("C7"), så att tomma celler hamnar rätt.
async function lasXlsx(arrayBuffer) {
  const filer = await packaUppZip(new Uint8Array(arrayBuffer));
  const xml = (namn) => filer[namn] && new DOMParser().parseFromString(new TextDecoder().decode(filer[namn]), 'application/xml');
  const alla = (dok, tagg) => [...(dok?.getElementsByTagNameNS('*', tagg) ?? [])];
  // Första bladet enligt arbetsboken; det heter inte alltid sheet1.xml.
  const id = alla(xml('xl/workbook.xml'), 'sheet')[0]?.getAttribute('r:id');
  const mal = alla(xml('xl/_rels/workbook.xml.rels'), 'Relationship').find((r) => r.getAttribute('Id') === id)?.getAttribute('Target');
  const blad = xml(mal ? `xl/${mal.replace(/^\/?xl\//, '')}` : 'xl/worksheets/sheet1.xml');
  if (!blad) throw new Error('Hittade inget blad i Excelfilen.');
  const text = (el) => alla(el, 't').map((t) => t.textContent).join('');
  const delad = alla(xml('xl/sharedStrings.xml'), 'si').map(text);
  const kolumn = (ref) => [...ref.replace(/\d+/g, '')].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0) - 1;
  return alla(blad, 'row').map((row) => {
    const rad = [];
    for (const c of alla(row, 'c')) {
      const t = c.getAttribute('t'), v = alla(c, 'v')[0]?.textContent ?? '', ref = c.getAttribute('r');
      rad[ref ? kolumn(ref) : rad.length] = t === 's' ? delad[Number(v)] ?? '' : t === 'inlineStr' ? text(c) : v;
    }
    return Array.from(rad, (x) => x ?? '');
  });
}

// Kolumnerna: rubriker som "Fastighetsbeteckning"/"Fastighet", "Adress"/"Gatuadress" och "Kommun"/"Ort". Saknas
// rubriker används kolumnen där flest celler ser ut som en beteckning (ord följt av "1:2"). -1 = finns inte.
const SER_UT_SOM_BETECKNING = /^\p{L}[\p{L}\- ]*\s\d+:\d+$/u;
// En rubrik är hela cellen ("Gatuadress"), inte ett ord i en beteckning som "FASTIGHETEN 1:2".
const AR_RUBRIK = /^((fastighets)?beteckning|fastighet|\p{L}*adress)$/iu;
function hittaKolumner(rader) {
  const i = rader.findIndex((r) => r.some((c) => AR_RUBRIK.test(String(c).trim())));
  if (i >= 0) {
    const rubriker = rader[i].map((c) => String(c).trim().toLowerCase());
    const kol = (re) => rubriker.findIndex((c) => re.test(c));
    return { start: i + 1, bet: kol(/beteckning|^fastighet$/), adress: kol(/adress|gata/), kommun: kol(/kommun|^ort$|postort/) };
  }
  const bredd = Math.max(0, ...rader.map((r) => r.length));
  const traffar = Array.from({ length: bredd }, (_, k) => rader.filter((r) => SER_UT_SOM_BETECKNING.test(String(r[k] ?? '').trim())).length);
  const bet = traffar.indexOf(Math.max(0, ...traffar));
  return { start: 0, bet: traffar[bet] ? bet : -1, adress: -1, kommun: -1 };
}

// Filen -> rader med radnummer (som i Excel), beteckning, adress och kommun; tomma rader hoppas över.
async function lasInFil(fil) {
  const rader = /\.(csv|txt)$/i.test(fil.name) ? lasCsv(await fil.text()) : await lasXlsx(await fil.arrayBuffer());
  const k = hittaKolumner(rader);
  if (k.bet < 0 && k.adress < 0) throw new Error('Hittade ingen kolumn med fastighetsbeteckning eller adress. Ladda ner mallen och se hur filen ska se ut.');
  const cell = (r, i) => (i < 0 ? '' : String(r[i] ?? '').trim());
  return rader.slice(k.start).map((r, j) => ({ rad: k.start + j + 1, bet: cell(r, k.bet), adress: cell(r, k.adress), kommun: cell(r, k.kommun) }))
    .filter((r) => r.bet || r.adress);
}

// Mallen: rubrikerna Horos känner igen, ett exempel med beteckning och ett med adress, båda med kommun (krävs).
const INLASNING_MALL = '﻿Fastighetsbeteckning;Adress;Kommun\r\nKUNGSBRON 1;;Stockholm\r\n;Drottninggatan 53;Stockholm\r\n';
