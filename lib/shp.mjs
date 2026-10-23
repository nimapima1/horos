// Shapefile (.shp + .dbf + .prj) med polygoner, utan beroenden. Ger ringarna i källans koordinatsystem.
import { readFileSync, existsSync } from 'node:fs';

export function lasShape(sokvag) {
  const shp = readFileSync(sokvag), dbf = readFileSync(sokvag.replace(/\.shp$/i, '.dbf'));
  const cpg = sokvag.replace(/\.shp$/i, '.cpg');
  const dec = new TextDecoder(existsSync(cpg) && /utf-?8/i.test(readFileSync(cpg, 'utf8')) ? 'utf-8' : 'windows-1252');
  // dbf: antal poster, huvudets och postens längd, fältbeskrivningar à 32 byte fram till 0x0D.
  const antal = dbf.readUInt32LE(4), huvud = dbf.readUInt16LE(8), postlangd = dbf.readUInt16LE(10);
  const falt = [];
  for (let o = 32; dbf[o] !== 0x0d; o += 32) {
    if (o + 32 > Math.min(huvud, dbf.length)) throw new Error('dbf-filen är skadad: fältbeskrivningarna saknar avslutning.');
    falt.push([dbf.toString('latin1', o, o + 11).replace(/\0.*$/s, ''), dbf[o + 16]]);
  }
  const attribut = (i) => {
    let o = huvud + i * postlangd + 1;
    const p = {};
    for (const [namn, langd] of falt) { p[namn] = dec.decode(dbf.subarray(o, o + langd)).trim(); o += langd; }
    return p;
  };
  // shp: 100 byte huvud, sedan poster med storendiansk längd; polygon (5/15/25) = ruta, delar, punkter.
  const ut = [];
  for (let o = 100, i = 0; o < shp.length; i++) {
    const langd = shp.readInt32BE(o + 4) * 2, c = o + 8, typ = shp.readInt32LE(c);
    if ([5, 15, 25].includes(typ)) {
      const delar = shp.readInt32LE(c + 36), punkter = shp.readInt32LE(c + 40), p0 = c + 44 + 4 * delar;
      const start = Array.from({ length: delar }, (_, d) => shp.readInt32LE(c + 44 + 4 * d));
      const rings = start.map((s, d) => Array.from({ length: (start[d + 1] ?? punkter) - s },
        (_, k) => [shp.readDoubleLE(p0 + 16 * (s + k)), shp.readDoubleLE(p0 + 16 * (s + k) + 8)]));
      ut.push({ id: i, p: attribut(i), rings });
    } else if (typ !== 0) throw new Error(`Shapefilen har geometrityp ${typ}, förväntade polygoner.`);
    o = c + langd;
  }
  if (ut.length > antal) throw new Error('Shapefilen har fler geometrier än dbf-poster.');
  // Utan .prj (Ängelholm) blir projektionen okänd; den får då anges i källan.
  const prjFil = sokvag.replace(/\.shp$/i, '.prj');
  const prj = existsSync(prjFil) ? readFileSync(prjFil, 'utf8') : '';
  const tal = (namn) => Number(prj.match(new RegExp(`"${namn}",(-?[\\d.]+)`, 'i'))?.[1]);
  return { objekt: ut, projektion: { lon0: tal('Central_Meridian'), k0: tal('Scale_Factor'), FE: tal('False_Easting') } };
}
