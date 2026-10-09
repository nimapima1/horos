// GeoPackage-geometri (WKB) och SWEREF 99 TM -> WGS84, utan beroenden.

// --- SWEREF 99 TM (EPSG:3006) -> WGS84 lon/lat -------------------------------
// Gauss–Krüger enligt Lantmäteriets formler, GRS80-ellipsoiden.
const a = 6378137.0;
const f = 1 / 298.257222101;
const k0 = 0.9996, lon0 = (15 * Math.PI) / 180, FN = 0, FE = 500000;
const e2 = f * (2 - f);
const n = f / (2 - f);
const aRoof = (a / (1 + n)) * (1 + (n * n) / 4 + (n ** 4) / 64);
const d1 = n / 2 - (2 / 3) * n ** 2 + (37 / 96) * n ** 3 - (1 / 360) * n ** 4;
const d2 = (1 / 48) * n ** 2 + (1 / 15) * n ** 3 - (437 / 1440) * n ** 4;
const d3 = (17 / 480) * n ** 3 - (37 / 840) * n ** 4;
const d4 = (4397 / 161280) * n ** 4;
// Koefficienter för den omvända riktningen (skiljer sig från framåtformelns).
const As = e2 + e2 ** 2 + e2 ** 3 + e2 ** 4;
const Bs = -(7 * e2 ** 2 + 17 * e2 ** 3 + 30 * e2 ** 4) / 6;
const Cs = (224 * e2 ** 3 + 889 * e2 ** 4) / 120;
const Ds = -(4279 * e2 ** 4) / 1260;

export function sweref99tmToWgs84(x /* easting */, y /* northing */) {
  const xi = (y - FN) / (k0 * aRoof);
  const eta = (x - FE) / (k0 * aRoof);
  const xiP = xi
    - d1 * Math.sin(2 * xi) * Math.cosh(2 * eta)
    - d2 * Math.sin(4 * xi) * Math.cosh(4 * eta)
    - d3 * Math.sin(6 * xi) * Math.cosh(6 * eta)
    - d4 * Math.sin(8 * xi) * Math.cosh(8 * eta);
  const etaP = eta
    - d1 * Math.cos(2 * xi) * Math.sinh(2 * eta)
    - d2 * Math.cos(4 * xi) * Math.sinh(4 * eta)
    - d3 * Math.cos(6 * xi) * Math.sinh(6 * eta)
    - d4 * Math.cos(8 * xi) * Math.sinh(8 * eta);
  const phiStar = Math.asin(Math.sin(xiP) / Math.cosh(etaP));
  const dLon = Math.atan(Math.sinh(etaP) / Math.cos(xiP));
  const s = Math.sin(phiStar);
  const lat = phiStar + s * Math.cos(phiStar) * (As + Bs * s ** 2 + Cs * s ** 4 + Ds * s ** 6);
  return [((lon0 + dLon) * 180) / Math.PI, (lat * 180) / Math.PI];
}

// --- GeoPackage binary -> GeoJSON-geometri (i källans koordinatsystem) ---------
export function parseGpkgGeometry(buf) {
  if (!buf || buf[0] !== 0x47 || buf[1] !== 0x50) throw new Error('Inte en GeoPackage-geometri');
  const flags = buf[3];
  const envelope = (flags >> 1) & 0x07;
  const envLen = [0, 32, 48, 48, 64][envelope] ?? 0;
  if ((flags >> 4) & 1) return null; // tom geometri
  return parseWkb(Buffer.from(buf.buffer, buf.byteOffset + 8 + envLen, buf.byteLength - 8 - envLen));
}

export function parseWkb(buf) {
  let o = 0;
  function geom() {
    const le = buf[o] === 1; o += 1;
    const u32 = () => { const v = le ? buf.readUInt32LE(o) : buf.readUInt32BE(o); o += 4; return v; };
    const f64 = () => { const v = le ? buf.readDoubleLE(o) : buf.readDoubleBE(o); o += 8; return v; };
    let type = u32();
    // ISO (1000/2000/3000-serier) och EWKB-flaggor för Z/M.
    let dims = 2;
    if (type & 0x80000000) { dims++; type &= 0x0fffffff; }
    if (type & 0x40000000) { dims++; type &= 0x0fffffff; }
    if (type > 1000) { dims += Math.floor(type / 1000) === 3 ? 2 : 1; type %= 1000; }
    const pt = () => { const x = f64(), y = f64(); for (let i = 2; i < dims; i++) f64(); return [x, y]; };
    const ring = () => { const k = u32(); const r = new Array(k); for (let i = 0; i < k; i++) r[i] = pt(); return r; };
    switch (type) {
      case 3: { const k = u32(); const rings = []; for (let i = 0; i < k; i++) rings.push(ring()); return { type: 'Polygon', coordinates: rings }; }
      case 6: { const k = u32(); const polys = []; for (let i = 0; i < k; i++) polys.push(geom().coordinates); return { type: 'MultiPolygon', coordinates: polys }; }
      case 1: return { type: 'Point', coordinates: pt() };
      case 2: return { type: 'LineString', coordinates: ring() };
      default: throw new Error(`WKB-typ ${type} stöds inte`);
    }
  }
  return geom();
}

export function mapCoords(geom, fn) {
  const walk = (c) => (typeof c[0] === 'number' ? fn(c) : c.map(walk));
  return { type: geom.type, coordinates: walk(geom.coordinates) };
}

// Planar area (m²) för Polygon/MultiPolygon i ett metriskt system.
export function planarArea(geom) {
  const ringArea = (r) => {
    let s = 0;
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) s += r[j][0] * r[i][1] - r[i][0] * r[j][1];
    return s / 2;
  };
  const polyArea = (p) => Math.abs(ringArea(p[0])) - p.slice(1).reduce((s, h) => s + Math.abs(ringArea(h)), 0);
  if (geom.type === 'Polygon') return polyArea(geom.coordinates);
  if (geom.type === 'MultiPolygon') return geom.coordinates.reduce((s, p) => s + polyArea(p), 0);
  return 0;
}

// Avrundar koordinater (6 decimaler ≈ 0,1 m) för mindre JSON.
export const round6 = ([x, y]) => [Math.round(x * 1e6) / 1e6, Math.round(y * 1e6) / 1e6];
