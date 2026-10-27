// Hjälp för testerna: en minimal zip (som en .xlsx).
import { deflateRawSync } from 'node:zlib';

// En zip med en packad (deflate) och en opackad fil, som Excel skriver dem.
export function zip(filer) {
  const lokala = [], centrala = [];
  let offset = 0;
  for (const [namn, text, packa] of filer) {
    const data = Buffer.from(text), ut = packa ? deflateRawSync(data) : data, n = Buffer.from(namn);
    const lokal = Buffer.alloc(30); lokal.writeUInt32LE(0x04034b50, 0); lokal.writeUInt16LE(packa ? 8 : 0, 8);
    lokal.writeUInt32LE(ut.length, 18); lokal.writeUInt32LE(data.length, 22); lokal.writeUInt16LE(n.length, 26);
    const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(packa ? 8 : 0, 10);
    central.writeUInt32LE(ut.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(n.length, 28);
    central.writeUInt32LE(offset, 42);
    lokala.push(lokal, n, ut); centrala.push(central, n);
    offset += 30 + n.length + ut.length;
  }
  const cd = Buffer.concat(centrala), slut = Buffer.alloc(22);
  slut.writeUInt32LE(0x06054b50, 0); slut.writeUInt16LE(filer.length, 10); slut.writeUInt32LE(cd.length, 12); slut.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...lokala, cd, slut]));
}
