// CSV/Excel-export-läsare för myndighetsfiler: gissar teckenkodning och avgränsare,
// och matchar kolumner mot fältnamn via synonymer (kan överstyras med --map fält=kolumn).
import { readFileSync } from 'node:fs';
export { csvCell } from '../public/csv.js';

export function readTable(file) {
  const raw = readFileSync(file);
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
    if (i < 0) i = h.findIndex((c) => cands.some((s) => c.includes(s)));
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
