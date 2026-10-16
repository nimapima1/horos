// Lantmäteriets ortofoto (STAC-katalogen, CC BY 4.0): registret över bilderna och valet av bilder till
// en kartruta. Rutorna ritas av lib/ortofoto.py; servern håller ihop det (server.mjs).
import { DatabaseSync } from 'node:sqlite';
import { pointInGeom } from './geo.mjs';

export const STAC = 'https://api.lantmateriet.se/stac-bild/v1';
export const ZOOM = [14, 18];      // under 14 täcker en ruta för många bilder; där visas satellitbilden
export const FINAST = 0.3;          // m/pixel: åtagandet är högst ~0,3 m, finare bilder läses i en översikt

// Översikten att läsa: GDAL:s nivå 0 är halva upplösningen, nivå 1 en fjärdedel osv. -1 = originalet.
// Aldrig finare än FINAST, och så grov som rutan tål (mal = rutans m/pixel), så att lite behöver hämtas.
// shortcut: antar minst 5 översikter (bilderna är 10 000–15 625 px); läs antalet ur filen om en bild har färre.
const MAX_NIVA = 4;
export function ovrNiva(upplosning, mal = 0) {
  let niva = -1;
  while (upplosning * 2 ** (niva + 1) < FINAST || upplosning * 2 ** (niva + 2) <= mal) niva++;
  return Math.min(niva, MAX_NIVA);
}

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
