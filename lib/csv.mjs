// CSV/Excel-export-läsare för myndighetsfiler: gissar teckenkodning och avgränsare,
// och matchar kolumner mot fältnamn via synonymer (kan överstyras med --map fält=kolumn).
import { readFileSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';
export { csvCell } from '../public/csv.js';

export function readTable(file) {
  const raw = readFileSync(file);
  if (/\.xlsx$/i.test(file)) {
    const [header, ...rows] = readXlsx(raw).filter((r) => r.some((c) => c.trim() !== ''));
    return { header: header.map((h) => h.trim()), rows, delim: null };
  }
  // UTF-8 om filen avkodas utan ersättningstecken, annars Windows-1252/Latin-1.
  let text = raw.toString('utf8');
  if (text.includes('�')) text = new TextDecoder('windows-1252').decode(raw);
  text = text.replace(/^﻿/, '');
  const nl = text.indexOf('\n');
  const first = nl < 0 ? text : text.slice(0, nl);
  const delim = [';', '\t', ','].sort((x, y) => first.split(y).length - first.split(x).length)[0];
  const rows = parse(text, delim).filter((r) => r.some((c) => c.trim() !== ''));
  const header = rows.shift().map((h) => h.trim());
  return { header, rows, delim };
}

// Första bladet i en .xlsx (en zip med XML), samma tolkning som lasXlsx i public/inlasning.js men utan DOMParser.
// shortcut: inte zip64 (filer över 4 GB); myndigheternas uttag är långt mindre.
export function readXlsx(buf) {
  let slut = buf.length - 22;
  while (slut >= 0 && buf.readUInt32LE(slut) !== 0x06054b50) slut--;
  if (slut < 0) throw new Error('Filen är inte en Excelfil (.xlsx).');
  const filer = {};
  let p = buf.readUInt32LE(slut + 16);
  for (let n = buf.readUInt16LE(slut + 10); n > 0; n--) {
    const metod = buf.readUInt16LE(p + 10), storlek = buf.readUInt32LE(p + 20), namnLangd = buf.readUInt16LE(p + 28);
    const lokal = buf.readUInt32LE(p + 42), namn = buf.toString('utf8', p + 46, p + 46 + namnLangd);
    const start = lokal + 30 + buf.readUInt16LE(lokal + 26) + buf.readUInt16LE(lokal + 28), data = buf.subarray(start, start + storlek);
    if (metod === 0 || metod === 8) filer[namn] = (metod === 8 ? inflateRawSync(data) : data).toString('utf8');
    p += 46 + namnLangd + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
  }
  const id = filer['xl/workbook.xml']?.match(/<sheet\b[^>]*\br:id="([^"]+)"/)?.[1];
  const mal = (filer['xl/_rels/workbook.xml.rels']?.match(/<Relationship\b[^>]*>/g) ?? [])
    .find((r) => id && r.includes(` Id="${id}"`))?.match(/\bTarget="([^"]+)"/)?.[1];
  const blad = filer[mal ? `xl/${mal.replace(/^\/?xl\//, '')}` : 'xl/worksheets/sheet1.xml'];
  if (!blad) throw new Error('Hittade inget blad i Excelfilen.');
  const ent = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
  const xmlText = (s) => s.replace(/&(?:#x([0-9a-f]+)|#(\d+)|(\w+));/gi, (m, h, d, e) =>
    h ? String.fromCodePoint(parseInt(h, 16)) : d ? String.fromCodePoint(Number(d)) : ent[e] ?? m);
  const text = (s) => [...s.matchAll(/<t\b[^>]*>([^<]*)<\/t>/g)].map((m) => xmlText(m[1])).join('');
  const delad = [...(filer['xl/sharedStrings.xml'] ?? '').matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => text(m[1]));
  const kolumn = (ref) => [...ref.replace(/\d+/g, '')].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0) - 1;
  return [...blad.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)].map(([, row]) => {
    const rad = [];
    for (const [, attr, inne = ''] of row.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const t = attr.match(/\bt="(\w+)"/)?.[1], ref = attr.match(/\br="([A-Z]+)\d+"/)?.[1], v = xmlText(inne.match(/<v>([^<]*)<\/v>/)?.[1] ?? '');
      rad[ref ? kolumn(ref) : rad.length] = t === 's' ? (v && delad[Number(v)]) ?? '' : t === 'inlineStr' ? text(inne) : v;
    }
    return Array.from(rad, (x) => x ?? '');
  });
}

function parse(text, delim) {
  const rows = [];
  let row = [], cur = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"' && text[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') inQ = false;
      else cur += c;
    } else if (c === '"') inQ = true;
    else if (c === delim) { row.push(cur); cur = ''; }
    else if (c === '\n') { row.push(cur.replace(/\r$/, '')); rows.push(row); row = []; cur = ''; }
    else cur += c;
  }
  if (cur !== '' || row.length) { row.push(cur.replace(/\r$/, '')); rows.push(row); }
  return rows;
}

const norm = (s) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, '');

// fields: { fält: [synonymer...] }. Returnerar { fält: kolumnindex } och vilka som saknas.
export function mapColumns(header, fields, overrides = {}) {
  const idx = {};
  const h = header.map(norm);
  for (const [field, syns] of Object.entries(fields)) {
    if (overrides[field]) {
      const i = header.indexOf(overrides[field]);
      if (i < 0) throw new Error(`Kolumnen "${overrides[field]}" finns inte. Kolumner: ${header.join(', ')}`);
      idx[field] = i;
      continue;
    }
    const cands = syns.map(norm);
    let i = h.findIndex((c) => cands.includes(c));
    // Delord bara i kolumner som inget tidigare fält tagit ("Markvärde" innehåller också "varde").
    if (i < 0) i = h.findIndex((c, j) => !Object.values(idx).includes(j) && cands.some((s) => c.includes(s)));
    if (i >= 0) idx[field] = i;
  }
  return idx;
}

// Läser filen, matchar kolumnerna, skriver ut matchningen (så att den kan kontrolleras med
// --dry) och avbryter om ett obligatoriskt fält saknas. get(rad, fält) ger trimmat värde eller null.
export function loadMapped(file, fields, overrides, required) {
  const { header, rows } = readTable(file);
  const col = mapColumns(header, fields, overrides);
  console.log(`${rows.length} rader. Kolumner i filen: ${header.join(' | ')}`);
  const w = Math.max(...Object.keys(fields).map((f) => f.length)) + 2;
  for (const f of Object.keys(fields)) console.log(`  ${f.padEnd(w)}-> ${col[f] != null ? header[col[f]] : '(saknas)'}`);
  const saknas = required.filter((f) => col[f] == null);
  if (saknas.length) {
    console.error(`\nMåste hittas men saknas: ${saknas.join(', ')}. Ange med --map, t.ex. --map ${saknas[0]}="Kolumnnamn"`);
    process.exit(1);
  }
  const get = (r, f) => (col[f] != null ? String(r[col[f]] ?? '').trim() || null : null);
  return { rows, get, col, header };
}

export function parseArgs(argv) {
  const out = { _: [], map: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--map') { const [k, v] = argv[++i].split('='); out.map[k] = v; }
    else if (a.startsWith('--')) out[a.slice(2)] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
    else out._.push(a);
  }
  return out;
}

// "1 234 567", "1234567,00", "1.234.567" -> 1234567
export function num(s) {
  if (s == null) return null;
  let t = String(s).replace(/\s| /g, '');
  if (t === '' || t === '-') return null;
  if (/^\d{1,3}(\.\d{3})+(,\d+)?$/.test(t)) t = t.replace(/\./g, '');
  t = t.replace(',', '.');
  const v = Number(t);
  return Number.isFinite(v) ? v : null;
}

export function isoDate(s) {
  const t = String(s ?? '').trim();
  if (/^\d{8}$/.test(t)) return `${t.slice(0, 4)}-${t.slice(4, 6)}-${t.slice(6)}`;
  const m = t.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? m[0] : t || null;
}

// dBase III: 32 byte huvud, 32 byte per fält till 0x0D, sedan poster med fast längd (först en
// raderingsflagga). Texten är UTF-8 enligt filens .cpg.
export function readDbf(buf) {
  const antal = buf.readUInt32LE(4), huvud = buf.readUInt16LE(8), postLangd = buf.readUInt16LE(10);
  const falt = [];
  for (let o = 32; buf[o] !== 0x0d; o += 32) falt.push({ namn: buf.toString('latin1', o, o + 11).replace(/\0.*$/s, ''), langd: buf[o + 16] });
  const rader = [];
  for (let r = 0; r < antal; r++) {
    let o = huvud + r * postLangd;
    if (buf[o] === 0x2a) continue;   // '*' = raderad
    o++;
    const rad = {};
    for (const f of falt) { rad[f.namn] = buf.toString('utf8', o, o + f.langd).trim(); o += f.langd; }
    rader.push(rad);
  }
  return rader;
}
