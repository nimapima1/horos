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
  `lib/scb.mjs` (SCB:s företagsregister: nyckeln, paus före varje anrop, sidhämtning; används av SCB-importerna).
  `lib/scenarier.mjs` (lagringen av korta länkar: `oppnaScenarier`, `giltigtScenario`, `MAX_SCENARIO`),
  `lib/kommuner.mjs` (län, kommuner, och `kommunAv`/`kommunForst` för kommunnamn i filer).
- Kartfiltren: `FILTER` i `server.mjs`, `[parameter, omvandling, SQL-villkor]`; WHERE-delen byggs ur listan.
- `public/`: `index.html` + `kalkyl.js` (kassaflödeskalkylen, utan DOM, testas i `test/kalkyl.test.mjs`) + `panel.js`
  (panelvyerna, bara deklarationer) + `inlasning.js` (inläsning från Excel/CSV, från filval till rapport, bara deklarationer; tolkningen testas i
  `test/inlasning.test.mjs`) + `scenario.js` (scenarierna, bara deklarationer) + `app.js` (karta,
  filter, sök, status och all inkoppling), `metod.html`, `style.css`
  (ui-ux-pro-max: Swiss/minimalism + glas, Lexend/Source Sans 3, slate/#0369A1). CSP tillåter
  inga inline-skript.
- Importskript i `scripts/`: `import-bolag`, `import-fastigheter` (GPKG), `import-taxering`,
  `import-lagfarter`, `import-adresser` (OSM via Overpass, eller `--fil`), `import-planer`
  (Markreglerande bestämmelse, GPKG per kommun), `import-nyheter` (pressmeddelanden från Cision → `nyhet`/`nyhet_plats`, bara fakta och länk), `import-agarkontroll` (SCB:s ägarkontroll → `bolag.agarkontroll`; statligt/kommunalt/regionägt i ägarkategorin), `import-fororenade` (länsstyrelsernas EBH, .dbf, CC BY 4.0) och `import-utsatta` (Polisens utsatta områden, GeoJSON) för panelens rutor Förorenade områden (150 m) och Utsatta områden (5 km), `import-arbetsstallen` (SCB:s företagsregister, API-nyckel i
  `SCB_API_KEY`, kopplas till fastighet med punkt-i-polygon), `demo-data` (även påhittade planer och arbetsställen).
- Scenarier (`#scenario`, som Datschas "Scenarion"): egen kassaflödeskalkyl för upp till 1 000 fastigheter, utan
  inloggning. `POST /api/underlag` ger fastigheterna, `POST /api/scenario` sparar (id = hash av innehållet, så en
  länk `#s=<id>` ändras aldrig) i en egen databas: `SCENARIO_DB`, annars `$STATE_DIRECTORY` (systemd), lokalt
  `data/scenarion.sqlite`. Utan skrivbar plats blir länken `#sd=<scenariot komprimerat>`. Flera scenarier i
  `localStorage` (`horos.scenarion` med data, sparas vid varje ändring; `horos.aktivt` = det öppna); export som CSV och scenariofil (JSON).
  Scenarier som räknas (tabellen överst i scenariovyn): Med lägger ihop andra scenarier (`delar`, kopior med egna
  antaganden som uppdateras när scenariot öppnas från Mina scenarion; delade länkar och filer behåller de sparade kopiorna; `beraknaPortfolj` i kalkyl.js summerar, varje
  fastighet en gång); Huvud väljer huvudscenariot (period och antaganden gäller först), gruppen flyttar dit. Kartan visar
  det öppna och de ihoplagda i tabellens färger, vitt där de överlappar. Horos har inga marknadshyror eller
  avkastningskrav: användaren fyller i dem.
  Läs in från fil (Mina scenarion): Excel (.xlsx, uppackad i webbläsaren utan beroenden) eller CSV med kolumnerna
  Fastighetsbeteckning + Kommun eller Adress + Kommun (mall att ladda ner) blir ett nytt scenario; filen laddas inte upp, raderna
  matchas med `POST /api/matcha`. Kommunen krävs (samma beteckning finns i flera kommuner): kolumn, först i beteckningen
  eller efter komma i adressen; alla 290 kommunnamn känns igen (`LAN_FOR_KOMMUN`), fastighetens kommun måste stämma.
- Ortofoto (Lantmäteriet, CC BY 4.0, beviljat 2026-10-16): STAC-katalogen https://api.lantmateriet.se/stac-bild/v1
  (en samling per område och år, t.ex. `orto-o2-2025` för Stockholm, 0,16 m, COG; bildfilerna kräver Geotorget-inloggningen).
  `scripts/bygg-ortofoto.mjs` hämtar översikten närmast 0,3 m och bygger WebP-rutor zoom 10–18 (z18 ≈ 0,3 m) i
  `TILES_DIR/ortofoto/<år>/` med `bounds.json`; servern läser dem vid start (`/tiles/ortofoto/`, `ortofoto` i status),
  bakgrundsväljaren visar "Foto <år>". På servern som root: `bash /opt/fastighetskarta/current/deploy/ortofoto.sh orto-o2-2025`
  (startar systemd-enheten `horos-ortofoto`, installerar GDAL, startar om appen; källfilerna sparas i `tiles/ortofoto-kalla/`).
- Rumsliga index: R-träd `fastighet_rtree`/`plan_rtree` (rowid). Byggs av build-public och,
  lokalt, av servern vid start. Servern klarar äldre publika databaser utan dem eller utan `plan`.
- Tester: `npm test` (node:test, `test/`).
- Importer: fastighetsbeteckningar kräver kommun i beteckningen, en kommunkolumn eller `--kommun namn|kod`. Taxering kräver `--enhet kr|tkr` om värdekolumnen saknar enhet.
  `--fullstandigt` på ett fullständigt nytt ägaruttag av lagfart/taxering får häva privatmarkeringar endast från den källan och för kända juridiska ägare, aldrig med `--append`; markeringar med okänd källa ligger kvar.
  `build-public.mjs` bygger `data/public.sqlite` med bara tillåtna fastigheter; Lantmäteriets
  data kräver `--lm-beslut <ärendenr>`, planerna `--lm-planer <ärendenr>`, arbetsställena `--scb-villkor`. Förorenade och utsatta områden tas alltid med (utsatta områden: Polisen anger inga villkor; användaren beslutade 2026-10-11 att publicera utan att fråga). Live byggs med `--alla-bolag`.
- Lokalt: `node --disable-warning=ExperimentalWarning server.mjs` (PATH: `/c/Program Files/nodejs`).
  Använd en annan port än 3000 (`PORT=3005`) om användaren har en egen server igång.
  SQLite-filer för test i `data/_test/` (långa sökvägar i scratchpad fungerar inte).
- Git-commits: `git -c user.name="Nima Behnejad" -c user.email="nima.behnejad@gmail.com" commit`.

`PRIVAT.md` (inte i git, repot är publikt): mejlkontakter, myndighetsärenden och kostnader. Lägg sådant där, inte här.

## Server

- Hetzner CX23 `horos-3`, Helsingfors, **37.27.152.172**, Ubuntu 24.04, `deploy/cloud-init.yaml` v3 plus ändringarna i v4–v5 (www-blocket, inget `Via`, `set-secret` utan längd), inlagda för hand som root 2026-10-10, och v6 (`deploy/scenarion.conf` som drop-in, `StateDirectory=horos-scenarion`) inlagd 2026-10-11. Root-lösenordet återställdes 2026-10-10 (Hetzner > Rescue).
  Trafiktak (installerat 2026-10-13): `deploy/trafiktak.sh` begränsar utgående trafik till 50 Mbit/s med `tc` (högst 16,7 TB/månad, 20 TB ingår, ~1 €/TB över), så massnedladdning kan inte ge en räkning. Installeras en gång som root: `bash /opt/fastighetskarta/current/deploy/trafiktak.sh installera` (systemd-tjänsten `horos-trafiktak`).
  Hetzners webbkonsol tappar Skift vid inklistring (`_ { } : &` blir `- [ ] ; 7`): skriv dem som
  `\x5f \x7b \x7d \x3a` i sed och kör kommandon var för sig i stället för med `&&`.
  Domän horos.se (Loopia, LoopiaDNS, köpt 2026-10-10; A-post @ och www -> servern; www skickas vidare till horos.se).
  E-post: kontakt@horos.se vidarebefordras till Gmail; Gmail skickar som den via smtp.gmail.com (SPF inkluderar Google).
- Internt heter allt fortfarande `fastighetskarta` (tjänst, `/opt/fastighetskarta`,
  `/var/lib/fastighetskarta`, `/usr/local/sbin/fastighetskarta-admin`).
- Publicera: `deploy/deploy.sh deploy@37.27.152.172 [--data]`. SSH-nyckeln har lösenfras, så det
  måste köras i användarens terminalflik:
  `& "C:\Program Files\Git\bin\bash.exe" deploy/deploy.sh deploy@37.27.152.172 --data`.
  Lösenfrasen måste skrivas inom ett par minuter, annars stänger servern anslutningen.
- Max 6 terminalflikar; flikar användaren skrivit i kan bara användaren stänga.
- Street View-rutan under Detaljplaner, `StreetView` i app.js (två klick: iframen skapas först vid klick) visas bara om `GOOGLE_EMBED_KEY`
  (Maps Embed API, låst till horos.se) finns i secrets.env; CSP:n i Caddy kräver `frame-src https://www.google.com`.
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

## Status (2026-10-11)

Live på https://horos.se (sedan 2026-10-10; http://37.27.152.172 fungerar inte längre): ny design och logotyp, bakgrundsväljare (karta, satellit 2025, flygfoton 2005/1995/1975/1960),
adressökning (120 177 OSM-adresser) och panel med Ägare/Användning/Senaste köp först.
Också live sedan 2026-10-10 (idéer från Datscha/Property Intel, bara gränssnittet tittat på):
- Kartan: filter (län och kommun (`lib/kommuner.mjs`, zoomar dit), ägare (namn/org.nr), ägarkategori, användning, lokalslag, upplåtelseform (tomträtt/äganderätt), ägartyp, värde, köpår, köpeskilling, tomtyta och uppskattad LOA från/till) med antal träffar och
  CSV-nedladdning (`/data/horos-traffar.csv`); "Färga efter" värde, värde/m², användning, ägartyp,
  köpår; prickar/kluster zoom 10–14 (`/api/punkter`), antal per kommun under zoom 10 (`/api/kommunkluster`); hovringsruta; delbar adress (`?l=&f=&farg=` + filter).
- Panelvyer: Transaktioner (`#transaktioner`, hette Affärer, `#affarer` fungerar fortfarande; `/api/affarer`: volym, per användning/kommun, köpare, största,
  senaste, säljare; sökfält `sok`: fastighet, köpare, säljare eller org.nr, alla år; affärerna i minnet (`byggAffarSok`), egen gräns `RATE_SOK`) och Största ägare (`#agare`, `/api/storsta-agare`, även i kartutsnittet).
- Fastighetspanelen: ägare sedan, köp/m², K/T-kvot, taxeringsändring, säljare, grannar, köp i närheten.
- Bolagspanelen: tomtareal, köp, sålt, "Visa alla på kartan" (`/api/fastigheter?org=`).
- Sök: ägare först med antal fastigheter (ägarlistan i minnet). Servertester i `test/server.test.mjs`.
- Pressmeddelanden (2026-10-10): `import-nyheter` hämtar 14 nyhetsrum på Cision; listan "Senaste i
  pressmeddelanden" i Transaktioner och "I pressmeddelanden" i fastighetspanelen, "Visa på kartan" ramar in.
  Privatperson som säljare: affären visas, namnet aldrig; försäljning till privatperson tas inte med.
  **MFN förbjuder automatisk hämtning** (robots.txt: `*.rss`, `*.xml`, `*.json`), men erbjöd 2026-10-12 att
  **skicka** pressmeddelanden (WebSub-POST, JSON) för bolag som distribuerar via MFN. Mottagaren: `POST /api/mfn`
  (signatur HMAC-SHA256 i `X-Hub-Signature` med `MFN_SECRET` i secrets.env; utan den finns ingen mottagare),
  `GET /api/mfn` svarar på `hub.challenge`. MFN skickar **alla** bolags pressmeddelanden (urval går inte);
  svenska köp/försäljningar (`tolkaMfn` i `lib/nyheter.mjs`) sparas med utgivarens org.nr, utan text, i
  `mfn.sqlite` i appens StateDirectory (`/var/lib/horos-scenarion`), en rad per mottaget i journalen. Cron för in
  bara fastighetsbolagens (`arFastighetsbolag`: SNI 68, namnet, eller listan `MFN_FASTIGHETSBOLAG` för moderbolag
  med SNI 70100/64xxx) med `import-nyheter --publik <fil> --mfn <mfn.sqlite>` (källa `mfn`, visas "via MFN").
  Ingen kostnad; MFN vill att de anges som källa. **Fastighetsvärlden** (2026-10-15): öppet flöde
  `sitemap.rss` (rubrik, länk, datum; pekas ut i robots.txt, inget förbehåll mot insamling), `TIDNINGAR` i
  `lib/nyheter.mjs`; bara `/notiser/` och bara affärer där den som köper eller säljer (`aktorIRubrik`) är ett bolag i
  `bolag_fts`; rubriken "Fastighetsköp av X" när namnet är ett registrerat bolag, exakt eller ett fastighets- eller holdingbolag som är nära nog (`aktorBolag`, `nyhet.aktor_orgnr`), annars utan bolagsnamn, "Enligt Fastighetsvärlden"; samma affär i flera källor (typ och pris lika, högst 3 dagar isär, inte olika kända kommuner; `inteDubblett` i server.mjs, index `nyhet_affar`) visas en gång: pressmeddelandet, annars tidningen som var först; i fastighetspanelen ersätter bara nyheter kopplade till samma fastighet; meddelande till redaktionen (utkast 2026-10-15,
  publicera först när det är skickat; slutar om de invänder). **Bonnier News (Fastighetsnytt, DI) förbjuder insamling** utan skriftligt tillstånd
  (robots.txt, bonniernews.se/info/upphovsratt-och-ai): inte med; begäran om tillstånd som utkast 2026-10-15 (se `PRIVAT.md`). På servern: cron (som deploy, inlagd av `deploy.sh`) kör
  `deploy/nyheter.sh` 05:15 och 15:15 UTC: `import-nyheter --publik` på en kopia av den publika databasen
  (platser bara på fastigheter i den, samma regel `NYHET_PLATS_UTANFOR` som build-public och serverns spärr), byter
  filen och startar om bara om något ändrades; hoppar över om appen är stoppad. Lås `databas.lock` delas med
  `deploy.sh`, som vid `--data` behåller serverns pressmeddelanden (`import-nyheter --behall`). Logg i
  `/var/lib/fastighetskarta/nyheter.log`.
- Företag på adressen (SCB-arbetsställen, 2026-10-10): tabell `arbetsstalle`, import, panel i fastighet och
  bolag, uppskattad användning från branscher. API-nyckel finns (användaren klistrar in den i terminalen); villkoren lästa 2026-10-10: spridning tillåten med
  källa "SCB (egen bearbetning)", reklamspärr ska markeras (inte uteslutas). Se `OVERLAMNING-hyresgaster.md`.
- Fastighetspanelen (2026-10-10): rutan Användning (lokaltyper, uppskattad LOA), tomtareal, LOA/BOA,
  exploateringstal, upplåtelseform (tomträtt/äganderätt). Typkoder → klartext i import-taxering.
  Senaste överlämning: `OVERLAMNING.md`.
- Scenarier (live 2026-10-11, PR #8): korta länkar på (`/api/status` → `kortlankar: true`), sparade i
  `/var/lib/horos-scenarion/scenarion.sqlite` (ingen säkerhetskopia). + i fastighetspanelen väljer scenario (eller
  nytt); + i sökträffarna, bolaget och filtret lägger till i det öppna. Panelen: Om/Metod/Data uppe till höger,
  flikraden Filter/Transaktioner/Ägare/Scenarier under sökfältet.
Den publika databasen har **0 fastigheter** (bara bolag, adresser och pressmeddelanden) tills riktiga data finns.

Väntar på:
- Svar på tillståndsmejlen (Fastighetsvärlden, Fastighetsnytt, MFN), skickade 2026-10-10 från kontakt@horos.se.
  MFN svarade 2026-10-12: skickar pressmeddelanden (push) för bolag som distribuerar via MFN och vill veta
  leveranssätt (HTTPS), format (JSON) och URL. Mottagaren `https://horos.se/api/mfn` är live sedan 2026-10-12
  med `MFN_SECRET` satt; hemligheten skickad till MFN 2026-10-12, leveransen igång (alla bolag, ingen kostnad,
  källa "MFN", prenumerationen förnyas inte). Väntar inte längre på MFN (se `PRIVAT.md`).
- Skatteverket: taxeringsvärden, ärendet pågår (detaljer i `PRIVAT.md`).
- Lantmäteriet (allmän handling): lagfarter/köpeskillingar från 2016 där förvärvaren är juridisk
  person, och nuvarande juridiska ägare. **Tomträttsinnehav är inte efterfrågat**: kontrollera när
  filen kommer om tomträtt/upplåtelseform finns med; annars begär det separat (se `OVERLAMNING.md`).
- Geotorget (Mitt konto > Ärenden, sidan laddar långsamt):
  - Fastighetsindelning Nedladdning, vektor – LM2026/153912, behandlas
  - Ortofoto Nedladdning – LM2026/153967, **beviljad** 2026-10-16 (STAC-API, se Teknik)
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

- ESG (vilande tills Lantmäteriet/Skatteverket finns): energideklarationer från Boverket, antingen uttag som
  allmän handling eller API (avtal kräver organisationsnummer, t.ex. en ideell förening; 1 500 anrop/dag).
  Certifieringar: SGBC har inget öppet register (BGO bara egna projekt). Förfrågningar till Boverket
  (allmän handling) och SGBC skickade 2026-10-11, se `PRIVAT.md`.
  Ingen hämtning via Boverkets e-tjänst eller BGO. Översvämning (MSB/SMHI) är inte gjord.
- När Byggnad beviljas: importera ändamål och visa som "Användning" (före taxeringstypen).
- När Belägenhetsadress beviljas: byt OSM-adresserna (`kalla='osm'`) mot Lantmäteriets.
