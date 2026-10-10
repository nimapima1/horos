# Horos – arbetsanteckningar för Claude

Horos är en öppen, ideell karta över fastigheter som ägs av **juridiska personer**, än så länge
i Stockholms kommun men på sikt **hela landet** (bygg inget som förutsätter Stockholm): ägare, användning, taxeringsvärde och senaste köpeskilling, byggd på öppna källor och
allmänna handlingar. Användaren skriver på svenska; svara på svenska.

Det besökarna främst vill se (enligt användaren, ~90 %): **nuvarande användning, ägare och senaste
köpeskilling**. Historiska flygfoton ("då och nu") är lågt prioriterade.

## Teknik

- Node 24, `node:sqlite`, inga npm-beroenden utöver maplibre-gl 4.7.1 och två typsnitt som
  kopieras till `public/vendor` av `scripts/vendor.mjs` (postinstall). Ingen byggkedja.
- `server.mjs`: rutt-tabell `[regex, bucket, handler]`, rate limit, proxy för satellit- och
  historiska kartrutor (diskcache), CSV/GeoJSON-export. `PUBLIC_MODE=1` vägrar starta om databasen
  har exempeldata, fastigheter utan juridisk ägare eller tabellen `har_privat_agare`.
- `lib/db.mjs` (schema, `normOrgnr` som avvisar personnummer, FTS-index för bolag och adresser),
  `lib/geo.mjs` (SWEREF99 TM → WGS84, GPKG, punkt-i-polygon), `lib/csv.mjs`,
  `lib/typkoder.mjs` (Skatteverkets typkoder → klartext per taxeringsår; används av import-taxering),
  `lib/lokaltyp.mjs` (arbetsställe → lokaltyp och uppskattad LOA; sparas i `arbetsstalle` vid importen).
  `lib/nyheter.mjs` (pressmeddelanden: RSS, utläsning av typ/pris/kommun/beteckning/adress, nyhetsrummen på Cision).
- Kartfiltren: `FILTER` i `server.mjs`, `[parameter, omvandling, SQL-villkor]`; WHERE-delen byggs ur listan.
- `public/`: `index.html` + `panel.js` (panelvyerna, bara deklarationer, laddas först) + `app.js` (karta,
  filter, sök, status och all inkoppling), `metod.html`, `style.css`
  (ui-ux-pro-max: Swiss/minimalism + glas, Lexend/Source Sans 3, slate/#0369A1). CSP tillåter
  inga inline-skript.
- Importskript i `scripts/`: `import-bolag`, `import-fastigheter` (GPKG), `import-taxering`,
  `import-lagfarter`, `import-adresser` (OSM via Overpass, eller `--fil`), `import-planer`
  (Markreglerande bestämmelse, GPKG per kommun), `import-nyheter` (pressmeddelanden från Cision → `nyhet`/`nyhet_plats`, bara fakta och länk), `import-arbetsstallen` (SCB:s företagsregister, API-nyckel i
  `SCB_API_KEY`, kopplas till fastighet med punkt-i-polygon), `demo-data` (även påhittade planer och arbetsställen).
- Rumsliga index: R-träd `fastighet_rtree`/`plan_rtree` (rowid). Byggs av build-public och,
  lokalt, av servern vid start. Servern klarar äldre publika databaser utan dem eller utan `plan`.
- Tester: `npm test` (node:test, `test/`).
  `build-public.mjs` bygger `data/public.sqlite` med bara tillåtna fastigheter; Lantmäteriets
  data kräver `--lm-beslut <ärendenr>`, planerna `--lm-planer <ärendenr>`, arbetsställena `--scb-villkor`. Live byggs med `--alla-bolag`.
- Lokalt: `node --disable-warning=ExperimentalWarning server.mjs` (PATH: `/c/Program Files/nodejs`).
  Använd en annan port än 3000 (`PORT=3005`) om användaren har en egen server igång.
  SQLite-filer för test i `data/_test/` (långa sökvägar i scratchpad fungerar inte).
- Git-commits: `git -c user.name="Nima Behnejad" -c user.email="nima.behnejad@gmail.com" commit`.

`PRIVAT.md` (inte i git, repot är publikt): mejlkontakter, myndighetsärenden och kostnader. Lägg sådant där, inte här.

## Server

- Hetzner CX23 `horos-3`, Helsingfors, **37.27.152.172**, Ubuntu 24.04, `deploy/cloud-init.yaml` v3 (+ www-blocket från v4, lagt in för hand som root 2026-10-10).
  Domän horos.se (Loopia, LoopiaDNS, köpt 2026-10-10; A-post @ -> servern, www pekar på Loopias parkering).
  E-post: kontakt@horos.se vidarebefordras till Gmail; Gmail skickar som den via smtp.gmail.com (SPF inkluderar Google).
- Internt heter allt fortfarande `fastighetskarta` (tjänst, `/opt/fastighetskarta`,
  `/var/lib/fastighetskarta`, `/usr/local/sbin/fastighetskarta-admin`).
- Publicera: `deploy/deploy.sh deploy@37.27.152.172 [--data]`. SSH-nyckeln har lösenfras, så det
  måste köras i användarens terminalflik:
  `& "C:\Program Files\Git\bin\bash.exe" deploy/deploy.sh deploy@37.27.152.172 --data`.
  Lösenfrasen måste skrivas inom ett par minuter, annars stänger servern anslutningen.
- Max 6 terminalflikar; flikar användaren skrivit i kan bara användaren stänga.
- Hemligheter (GEOTORGET_USER/PASS för historiska ortofoton) ligger i
  `/etc/fastighetskarta/secrets.env`, satta med `scripts/login-till-server.mjs`. Lösenord skrivs
  alltid av användaren i terminalen, aldrig i chatten.

## Regler och åtaganden (gäller alltid)

- Visa publikt bara fastigheter som ägs av juridiska personer; inga uppgifter om privatpersoner.
- Ingen skrapning av Datscha/Hemnet/Booli, ingen bulkhämtning från myndigheters e-tjänster för
  publicering, ingen dold trafik.
- Ortofoto: högst ~0,3 m/pixel, ingen nedladdning av bilder.
- Byggnad (om beviljad): ändamål och byggnadsytor visas bara för byggnader på fastigheter med
  juridisk ägare, ingen nedladdningsfil.
- Belägenhetsadress: för en adress utan fastighet i Horos visas bara att uppgifter saknas.
- Lagring: dedikerad VPS hos Hetzner i Finland (EU/EES) + arbetskopia på användarens dator.
- Personnummer, kontoskapande, köp och inskickning av ansökningar görs av användaren själv.
- Användarens Geotorget-konto används för allt som rör Lantmäteriet.

## Status (2026-10-10)

Live på https://horos.se (sedan 2026-10-10; http://37.27.152.172 fungerar inte längre): ny design och logotyp, bakgrundsväljare (karta, satellit 2025, flygfoton 2005/1995/1975/1960),
adressökning (120 177 OSM-adresser) och panel med Ägare/Användning/Senaste köp först.
Lokalt, inte publicerat än (2026-10-09, idéer från Datscha/Property Intel, bara gränssnittet tittat på):
- Kartan: filter (län och kommun (`lib/kommuner.mjs`, zoomar dit), ägare (namn/org.nr), ägarkategori, användning, lokalslag, upplåtelseform (tomträtt/äganderätt), ägartyp, värde, köpår, köpeskilling, tomtyta och uppskattad LOA från/till) med antal träffar och
  CSV-nedladdning (`/data/horos-traffar.csv`); "Färga efter" värde, värde/m², användning, ägartyp,
  köpår; prickar/kluster zoom 10–14 (`/api/punkter`), antal per kommun under zoom 10 (`/api/kommunkluster`); hovringsruta; delbar adress (`?l=&f=&farg=` + filter).
- Panelvyer: Affärer (`#affarer`, `/api/affarer`: volym, per användning/kommun, köpare, största,
  senaste, säljare) och Största ägare (`#agare`, `/api/storsta-agare`, även i kartutsnittet).
- Fastighetspanelen: ägare sedan, köp/m², K/T-kvot, taxeringsändring, säljare, grannar, köp i närheten.
- Bolagspanelen: tomtareal, köp, sålt, "Visa alla på kartan" (`/api/fastigheter?org=`).
- Sök: ägare först med antal fastigheter (ägarlistan i minnet). Servertester i `test/server.test.mjs`.
- Pressmeddelanden (2026-10-10): `import-nyheter` hämtar 14 nyhetsrum på Cision; listan "Senaste i
  pressmeddelanden" i Affärer och "I pressmeddelanden" i fastighetspanelen, "Visa på kartan" ramar in.
  Privatperson som säljare: affären visas, namnet aldrig; försäljning till privatperson tas inte med.
  **MFN förbjuder automatisk hämtning** (robots.txt: `*.rss`, `*.xml`, `*.json`): inte med förrän Modular
  Finance gett tillstånd. DI, Fastighetsnytt, Fastighetsvärlden skrapas inte; tillstånd för rubrik + länk
  efterfrågas (mejl 2026-10-10, se `PRIVAT.md`). Körs bara manuellt än; behöver ett schemalagt jobb på servern.
- Företag på adressen (SCB-arbetsställen, 2026-10-10): tabell `arbetsstalle`, import, panel i fastighet och
  bolag, uppskattad användning från branscher. API-nyckel finns (användaren klistrar in den i terminalen); villkoren lästa 2026-10-10: spridning tillåten med
  källa "SCB (egen bearbetning)", reklamspärr ska markeras (inte uteslutas). Se `OVERLAMNING-hyresgaster.md`.
- Fastighetspanelen (2026-10-10): rutan Användning (lokaltyper, uppskattad LOA), tomtareal, LOA/BOA,
  exploateringstal, upplåtelseform (tomträtt/äganderätt). Typkoder → klartext i import-taxering.
  Senaste överlämning: `OVERLAMNING.md`.
Den publika databasen har **0 fastigheter** (bara bolag och adresser) tills riktiga data finns.

Väntar på:
- Skatteverket: taxeringsvärden, ärendet pågår (detaljer i `PRIVAT.md`).
- Lantmäteriet (allmän handling): lagfarter/köpeskillingar från 2016 där förvärvaren är juridisk
  person, och nuvarande juridiska ägare. **Tomträttsinnehav är inte efterfrågat**: kontrollera när
  filen kommer om tomträtt/upplåtelseform finns med; annars begär det separat (se `OVERLAMNING.md`).
- Geotorget (Mitt konto > Ärenden, sidan laddar långsamt):
  - Fastighetsindelning Nedladdning, vektor – LM2026/153912, behandlas
  - Ortofoto Nedladdning – LM2026/153967, behandlas
  - Ortofoto historiska Visning – LM2026/153973, **beviljad** (används)
  - Belägenhetsadress Nedladdning, vektor – inskickad 2026-10-09
  - Byggnad Nedladdning, vektor – ifylld 2026-10-09; kontrollera att den skickades
- Lantmäteriet geodatasupport: förfrågan om rikstäckning skickad 2026-10-09 (frågor och kostnadsuppskattning
  i `PRIVAT.md`). Svaret avgör vägen till rikstäckning. Skrapning är uteslutet (risk att förlora licenserna).

När filer kommer: lägg i `data/raw/`, kör importskriptet med `--dry` först, påminn om åtagandena,
bygg med `build-public` och publicera.

## Att göra

- Rikstäckning: prickar/kluster från zoom 10 (`/api/punkter`, högst 30 000); under zoom 10 antal per
  kommun (`/api/kommunkluster`, hela landet med filtren, sparas per filter i minnet; mät med verklig data);
  historiska flygfoton och OSM-adresserna är fortfarande avgränsade till Stockholm; texter säger
  "i Stockholm" (stämmer tills annan data finns).
- Planer: länk till kommunens plandokument (insynsbk för Stockholm) när kolumnerna i filen är kända.

- www.horos.se: se till att www-posten i Loopia pekar på servern (Caddy skickar www vidare till horos.se).
- Vid nästa serverändring: ta bort längdutskriften i `set-secret` och Caddys `Via`-huvud.
- När Byggnad beviljas: importera ändamål och visa som "Användning" (före taxeringstypen).
- När Belägenhetsadress beviljas: byt OSM-adresserna (`kalla='osm'`) mot Lantmäteriets.
