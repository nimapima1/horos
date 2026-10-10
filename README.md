# Horos

En öppen karta över **bolagsägda fastigheter i Stockholm**, byggd enbart på offentliga
källor. Namnet kommer från antikens Athen, där gränsstenar (*horoi*) ställdes ut på tomter
för att offentligt visa vem som hade anspråk på marken. Klicka på en fastighet för att se ägare, taxeringsvärde och överlåtelser, eller sök
på ett bolag för att se vilka fastigheter det äger.

Prototypen innehåller bara juridiska personer. Uppgifter om fysiska personer (personnummer,
enskilda firmor, dödsbon, c/o-namn) filtreras bort i alla importskript.

## Kom igång

Kräver Node 22.13 eller senare. Enda beroendet är MapLibre, som kopieras till
`public/vendor/` vid `npm install` (sidan hämtar inga skript från tredje part).

```sh
npm run import:bolag      # Bolagsverket + SCB -> data/fastighetskarta.sqlite
npm run import:adresser   # adresser för sökningen från OpenStreetMap (Overpass)
npm run demo              # exempelfastigheter i centrala Stockholm (valfritt)
npm start                 # http://localhost:3000
npm test                  # tester (node:test)
```

## Källor

| Data | Källa | Status | Skript |
|---|---|---|---|
| Bolag: namn, form, SNI, adress, verksamhet | Bolagsverket + SCB, [värdefulla datamängder](https://bolagsverket.se/apierochoppnadata/hamtaforetagsinformation/nedladdningsbarafiler.2517.html) | ✅ Avgiftsfritt, ingen registrering | `import:bolag` |
| Fastighetsgränser | Lantmäteriet, *Fastighetsindelning Nedladdning, vektor* via [Geotorget](https://geotorget.lantmateriet.se) | ⏳ Avgiftsfri men kräver juridisk prövning (FRL); villkor för värdefulla datamängder med personuppgifter. Ansökan 2026-10-09 | `import:fastigheter` |
| Taxeringsvärden | Skatteverket, begäran om allmän handling | ⏳ Begärt 2026-10-09 | `import:taxering` |
| Lagfarna ägare, köpeskillingar | Lantmäteriet, begäran om allmän handling | ⏳ Begärt 2026-10-09 | `import:lagfarter` |
| Adresser (sökning) | © OpenStreetMap-bidragsgivare (ODbL); senare Lantmäteriet, *Belägenhetsadress Nedladdning, vektor* | ✅ OSM nu; ansökan hos Lantmäteriet förberedd | `import:adresser` |
| Detaljplaner, stadsplaner m.fl. | Lantmäteriet, *Markreglerande bestämmelse Nedladdning, vektor* (per kommun, GeoPackage) | ⏳ Licensavgift, faktor 0,1 för icke-kommersiell användning. Tas med i `build-public` först med `--lm-planer <ärendenr>` | `import:planer` |
| Användning (byggnaders ändamål) | Lantmäteriet, *Byggnad Nedladdning, vektor* | ⏳ Ansökan förberedd (GDPR-prövning) | – |
| Byggnader i exempeldatan | © OpenStreetMap-bidragsgivare (ODbL) | Endast demo | `demo` |

### Bolag

Ladda ner `bolagsverket_bulkfil.zip` och `scb_bulkfil.zip` (länkar ovan), packa upp dem till
`data/raw/bv/` och `data/raw/scb/`, och kör `npm run import:bolag`. Filerna uppdateras varje
vecka. Det går bra att köra om skriptet.

### Fastighetsgränser

1. Skapa ett konto på [Geotorget](https://geotorget.lantmateriet.se) och ansök om
   *Fastighetsindelning Nedladdning, vektor* (Beställning-fliken). Ansökan prövas enligt
   fastighetsregisterlagen. Ansökan anger lagring på en dedikerad VPS hos Hetzner (Finland)
   och att publikt bara fastigheter ägda av juridiska personer visas. Det åtagandet gäller.
   Produkten levereras via STAC-API (`https://api.lantmateriet.se/stac-vektor/v1`) som GeoPackage.
2. Lägg GeoPackage-filen i `data/raw/` och inspektera den:
   ```sh
   node scripts/import-fastigheter.mjs data/raw/<fil>.gpkg --list
   ```
3. Importera. Lager och kolumner gissas, men kan anges med `--layer`, `--beteckning` och
   `--kommun-kolumn`:
   ```sh
   node scripts/import-fastigheter.mjs data/raw/<fil>.gpkg --kommun 0180
   npm run demo -- --clear
   ```

### Detaljplaner

Ansök på Geotorget om *Markreglerande bestämmelse Nedladdning, vektor* (licensavgift per km²,
faktor 0,1 för icke-kommersiell användning). Den levereras per kommun; importera varje fil:

```sh
node scripts/import-planer.mjs data/raw/<fil>.gpkg --list   # lager, kolumner och plantyper
node scripts/import-planer.mjs data/raw/<fil>.gpkg --dry
node scripts/import-planer.mjs data/raw/<fil>.gpkg
```

Bara plantyper tas med (DP, ÄDP, SPL, BPL, OB, ÄOB, FP, TI, APL, GPL); naturreservat,
byggnadsminnen m.m. i samma fil hoppas över. Kolumner gissas och kan anges med `--typ`,
`--planid`, `--namn` och `--datum`.

### Taxering och lagfarter

Kolumnnamnen i myndigheternas filer är okända tills de kommer. Skripten gissar via synonymer.
Kör alltid `--dry` först och rätta med `--map fält=kolumn` vid behov:

```sh
node scripts/import-taxering.mjs data/raw/skatteverket.csv --dry
node scripts/import-taxering.mjs data/raw/skatteverket.csv --map beteckning="Fastighet"

node scripts/import-lagfarter.mjs data/raw/lm.csv --som transaktioner --dry
node scripts/import-lagfarter.mjs data/raw/lm-agare.csv --som agare
```

Excel-filer sparas först som CSV (UTF-8 eller semikolonseparerad).

## Publicering

Se [deploy/DEPLOY.md](deploy/DEPLOY.md) (Hetzner, Helsingfors). Kortfattat:

```sh
npm run build:public                  # data/public.sqlite: bara bolagsägda fastigheter
deploy/deploy.sh deploy@<IP> --data
```

Den publika databasen byggs separat och innehåller bara fastigheter med känd juridisk
ägare och utan privat delägare. Servern körs med `PUBLIC_MODE=1` och vägrar starta om
databasen bryter mot det. Testa lokalt med `npm run build:public && npm run start:public`.

## Struktur

```
server.mjs              HTTP-server + JSON-API (node:sqlite, inga beroenden)
public/                 kartan (MapLibre GL, OpenFreeMap-bakgrundskarta)
lib/db.mjs              schema och hjälpfunktioner, org.nr-filter mot personnummer
lib/geo.mjs             GeoPackage/WKB-läsare, SWEREF 99 TM -> WGS84
lib/csv.mjs             CSV-läsare med kolumngissning
scripts/                importskript, build-public.mjs, vendor.mjs
deploy/                 cloud-init för Hetzner, deploy.sh, DEPLOY.md
data/                   databas och råfiler (ingår inte i git)
```

### API

- `GET /api/status`: antal poster per tabell
- `GET /api/fastigheter?bbox=minLon,minLat,maxLon,maxLat`: GeoJSON för kartutsnittet
- `GET /api/planer?bbox=minLon,minLat,maxLon,maxLat`: planer (GeoJSON) i kartutsnittet
- `GET /api/fastighet/<beteckning>`: ägare, taxering, överlåtelser och gällande planer
- `GET /api/bolag/<orgnr>`: bolagsuppgifter och fastighetsinnehav
- `GET /api/sok?q=<text>`: bolag (namn/org.nr) och fastigheter (beteckning)
- `GET /data/horos-fastigheter.csv`: hela den publika datan (öppen data)
- `GET /data/horos-fastigheter.geojson`: med gränser, bara om databasen byggts med `--export-geometri`
- `GET /tiles/satellit/{z}/{x}/{y}.jpg`: satellitbild via servern (EOxCloudless/Sentinel-2 tills
  Lantmäteriets ortofoto finns), cachas i minnet så att besökarnas IP-adresser inte når tredje part

Sidan [metod.html](public/metod.html) beskriver källor, urval och begränsningar.

## Innan publicering

- Kontrollera licensvillkoren för varje Lantmäteriet-produkt under fliken *Villkor* på Geotorget.
- Ange källor enligt licenserna (Lantmäteriet, Bolagsverket/SCB, OpenStreetMap, OpenFreeMap).
- Ta bort exempeldatan (`npm run demo -- --clear`).
- Byt bakgrundskarta eller kontrollera OpenFreeMaps villkor vid mycket trafik.

## Licens

Koden är fri programvara under [GNU Affero General Public License v3.0](LICENSE) eller senare.
Licensen gäller bara koden. Uppgifterna kommer från Lantmäteriet, SCB, Bolagsverket, OpenStreetMap
m.fl. och har egna villkor (se tabellen ovan och metodsidan).
