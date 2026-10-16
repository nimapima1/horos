// Lantmäteriets ortofoto (STAC-katalogen, CC BY 4.0): registret över bilderna och valet av bilder till
// en kartruta. Rutorna ritas av lib/ortofoto.py; servern håller ihop det (server.mjs).
import { DatabaseSync } from 'node:sqlite';
import { pointInGeom } from './geo.mjs';

export const STAC = 'https://api.lantmateriet.se/stac-bild/v1';
export const ZOOM = [14, 18];      // under 14 täcker en ruta för många bilder; där visas satellitbilden

export function oppnaRegister(path, { skriv = false } = {}) {
  const db = new DatabaseSync(path, { readOnly: !skriv });
  if (skriv) {
    db.exec(`CREATE TABLE IF NOT EXISTS bild (id INTEGER PRIMARY KEY, namn TEXT NOT NULL, samling TEXT NOT NULL,
        href TEXT NOT NULL, datum TEXT NOT NULL, upplosning REAL NOT NULL, ruta TEXT NOT NULL UNIQUE, geometri TEXT NOT NULL,
        minx REAL, miny REAL, maxx REAL, maxy REAL);
      CREATE VIRTUAL TABLE IF NOT EXISTS bild_rtree USING rtree(id, minx, maxx, miny, maxy);
      CREATE TABLE IF NOT EXISTS meta (nyckel TEXT PRIMARY KEY, varde TEXT);`);
  }
  return db;
}

// Bilderna till en ruta, äldst först (nyare ritas över). Nyast först tills en bild täcker hela rutan;
// äldre bilder under den syns ändå inte.
export function valjBilder(bilder, horn) {
  const valda = [];
  for (const b of [...bilder].sort((a, c) => c.datum.localeCompare(a.datum))) {
    valda.push(b);
    const geom = JSON.parse(b.geometri);
    if (horn.every((p) => pointInGeom(p, geom))) break;
  }
  return valda.reverse();
}
