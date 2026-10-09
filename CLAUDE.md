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
  `lib/geo.mjs` (SWEREF99 TM → WGS84, GPKG, punkt-i-polygon), `lib/csv.mjs`.
- `public/`: `index.html` + `app.js` (karta, sök, panel), `metod.html`, `style.css`
  (ui-ux-pro-max: Swiss/minimalism + glas, Lexend/Source Sans 3, slate/#0369A1). CSP tillåter
  inga inline-skript.
- Importskript i `scripts/`: `import-bolag`, `import-fastigheter` (GPKG), `import-taxering`,
  `import-lagfarter`, `import-adresser` (OSM via Overpass, eller `--fil`), `import-planer`
  (Markreglerande bestämmelse, GPKG per kommun), `demo-data` (även påhittade planer).
- Rumsliga index: R-träd `fastighet_rtree`/`plan_rtree` (rowid). Byggs av build-public och,
  lokalt, av servern vid start. Servern klarar äldre publika databaser utan dem eller utan `plan`.
- Tester: `npm test` (node:test, `test/`).
  `build-public.mjs` bygger `data/public.sqlite` med bara tillåtna fastigheter; Lantmäteriets
  data kräver `--lm-beslut <ärendenr>`, planerna `--lm-planer <ärendenr>`. Live byggs med `--alla-bolag`.
- Lokalt: `node --disable-warning=ExperimentalWarning server.mjs` (PATH: `/c/Program Files/nodejs`).
  Använd en annan port än 3000 (`PORT=3005`) om användaren har en egen server igång.
  SQLite-filer för test i `data/_test/` (långa sökvägar i scratchpad fungerar inte).
- Git-commits: `git -c user.name="Nima Behnejad" -c user.email="nima.behnejad@gmail.com" commit`.

## Server

- Hetzner CX23 `horos-3`, Helsingfors, **37.27.152.172**, Ubuntu 24.04, `deploy/cloud-init.yaml` v3.
  Ingen domän än (horos.se verkade ledig 2026-10-09), alltså bara http.
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

## Status (2026-10-09)

Live: ny design och logotyp, bakgrundsväljare (karta, satellit 2025, flygfoton 2005/1995/1975/1960),
adressökning (120 177 OSM-adresser) och panel med Ägare/Användning/Senaste köp först.
Lokalt, inte publicerat än: kartfilter (användning, ägartyp, värde, köpår, köpeskilling, tomtyta),
"Färga efter" i teckenförklaringen, panelvyerna Affärer (`#affarer`, `/api/affarer`) och Största ägare
(`#agare`, `/api/storsta-agare`), samt "ägare sedan", köp per m² och K/T-kvot i fastighetspanelen.
Idéerna kommer från Datscha/Property Intel (bara gränssnittet tittat på, ingen data hämtad).
Den publika databasen har **0 fastigheter** (bara bolag och adresser) tills riktiga data finns.

Väntar på:
- Skatteverket: avslog taxeringsvärden (OSL 27:1); användaren har skickat en avgränsad begäran
  (bara värden, inte ägare, med hänvisning till 27:6) och begärt överklagbart beslut.
- Lantmäteriet (allmän handling): lagfarter/köpeskillingar från 2016 där förvärvaren är juridisk
  person, och nuvarande juridiska ägare.
- Geotorget (Mitt konto > Ärenden, sidan laddar långsamt):
  - Fastighetsindelning Nedladdning, vektor – LM2026/153912, behandlas
  - Ortofoto Nedladdning – LM2026/153967, behandlas
  - Ortofoto historiska Visning – LM2026/153973, **beviljad** (används)
  - Belägenhetsadress Nedladdning, vektor – inskickad 2026-10-09
  - Byggnad Nedladdning, vektor – ifylld 2026-10-09; kontrollera att den skickades
- Lantmäteriet geodatasupport (geodatasupport@lm.se, 026-63 36 00 vardagar 9–12): förfrågan
  skickad 2026-10-09 om rikstäckning. Frågor: ändamålsprövning för Fastighetsinformation
  (Inskrivning: ägare, förvärv) och Taxering Nedladdning vid icke-kommersiell användning; urval med
  bara juridiska ägare; köpeskilling i Förvärv eller Fastighetsprisuttag; publicering per fastighet;
  offert för hela landet; Markreglerande bestämmelse (detaljplaner) för hela landet; utökning av
  ärendena Fastighetsindelning/Belägenhetsadress/Byggnad till hela landet; FUK via forskningspartner.
  Uppskattning ur avgiftsdokumentet: ägare+förvärv+taxering ca 2 kr/registerenhet, ca 650 tkr + moms
  för hela landet med faktor 0,1 (mindre om urval på juridiska ägare går); planer ca 7–22 tkr/år.
  Svaret avgör vägen till rikstäckning. Formell ansökan görs sedan som beställning på Geotorget
  (helst alla produkter i samma beställning). Skrapning är uteslutet (risk att förlora licenserna).

När filer kommer: lägg i `data/raw/`, kör importskriptet med `--dry` först, påminn om åtagandena,
bygg med `build-public` och publicera.

## Att göra

- Rikstäckning: vid många fastigheter behövs lägsta zoom med prickar/kluster eller vektorrutor;
  historiska flygfoton och OSM-adresserna är fortfarande avgränsade till Stockholm; texter säger
  "i Stockholm" (stämmer tills annan data finns).
- Planer: länk till kommunens plandokument (insynsbk för Stockholm) när kolumnerna i filen är kända.

- Domän + HTTPS: `fastighetskarta-admin set-domain <domän>` när A/AAAA-posten pekar på servern.
- Kontaktuppgift på metodsidan (platshållare "kontaktuppgift kommer").
- Vid nästa serverändring: ta bort längdutskriften i `set-secret` och Caddys `Via`-huvud.
- När Byggnad beviljas: importera ändamål och visa som "Användning" (före taxeringstypen).
- När Belägenhetsadress beviljas: byt OSM-adresserna (`kalla='osm'`) mot Lantmäteriets.
