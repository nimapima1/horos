# Överlämning: hyresgäster och lokalanvändning i Horos

Skriven 2026-10-09 för en ny session. Läs `CLAUDE.md` först (regler, teknik, server). Den här filen
beskriver bara nästa arbete: visa **vilka företag som sitter i en fastighet** och **vad lokalerna
används till** (kontor, lager, butik …), som Datscha/Property Intel gör.

## Läget

- Allt från 2026-10-09 är committat på `master`. Publicerat (http://37.27.152.172) till och med commit
  d7585fa; rättningarna efter granskningarna (2639294 och aaa718c) är **inte publicerade** än. Den publika databasen
  har fortfarande 0 fastigheter.
- `npm test` ska ge 13 gröna tester, varav 10 i `test/server.test.mjs`. De startar servern mot en
  liten testdatabas i `data/_test/`. Följ samma mönster för nya API:er.
- Lokal server för att prova i webbläsarpanelen: `preview_start {name: "horos-3005"}`
  (`.claude/launch.json`), med exempeldata i `data/fastighetskarta.sqlite`.

## Vad Datscha visar (bara gränssnittet tittat på, ingen data sparad)

- **Fliken Hyresgäster** per fastighet: namn, organisationsnummer, bransch i klartext (SNI),
  antal anställda i storleksklass ("5–9", "20–49"), grupperat per adress ("Hyresgäster per adress").
  Ingen källa anges, men uppgifterna är exakt det SCB:s företagsregister har om **arbetsställen**.
  Hyresgästsökningen filtrerar på SNI nivå 1–5, antal anställda, kommun och adress, och kan visa
  "Hyresgäst summerat" eller "Hyresgäst per lokal".
- **Fliken Area & Typ**: "Ytor" med lokalslag (Kontor, Övrigt …), källa "Baserat på aggregerad
  myndighetsinformation". Taxeringen (källa Lantmäteriet) har bara Bostäder/Lokaler/Industri, typkod
  (t.ex. 325 Hyreshusenhet, huvudsakligen lokaler), taxerad hyra och byggrätt. Uppdelningen i kontor,
  lager osv. kommer **troligen** från byggnadernas ändamål i Lantmäteriets Byggnad (vår slutsats, inte
  bekräftat).
- Datscha har alltså inga hyreskontrakt: "hyresgäst" = företag med arbetsställe på fastighetens adress.

## Källan: SCB:s företagsregister (arbetsställen)

- Avgiftsfritt sedan 26 juni 2025 (förordningsändring). Ett API ger aktuella uppgifter om företag och
  arbetsställen: arbetsställets adress, SNI-kod, antal anställda i storleksklasser, arbetsställestatus
  (0 aldrig verksam, 1 verksam, 9 ej längre verksam), CFAR-nummer (arbetsställets id, 8 siffror).
- Åtkomst: registrering i SCB:s **Registreringsportalen**, godkänna användarvillkoren, ansöka om
  **personlig API-nyckel** (får inte delas). Det är kontoskapande: **användaren gör det själv**.
  Nyckeln ska aldrig skrivas i chatten; lägg den i en miljövariabel som användaren sätter i terminalen
  (jämför hur `scripts/login-till-server.mjs` hanterar hemligheter).
- Gränser: högst 5 000 rader per anrop (med sidindelning), 5 anrop per sekund per nyckel, bara
  aktuella data (ingen historik), ingen bulkfil. Stockholm bör gå på några tiotal anrop.
- Registret innehåller också **fysiska personer** med registrerad firma, F-skatt, moms eller
  arbetsgivarregistrering, alltså enskilda firmor.
- **Reklamspärr**: företag och arbetsställen med reklamspärr har aktivt frånsagt sig exponering.
- Källor: <https://www.scb.se/vara-tjanster/bestall-data-och-statistik/foretagsregistret/avgiftsfria-uppgifter-i-foretagsregistret/>,
  variabelbeskrivning (PDF): <https://www.scb.se/contentassets/8a8eb5c3d45f461ea93482f8e8d4de4f/variabelbeskrivning-api.pdf>,
  postbeskrivning arbetsställen (postbeskrivning-ae.pdf, länkas från samma sida).

## Öppna frågor (reds ut först)

1. **Användarvillkoren** i Registreringsportalen: får uppgifterna publiceras per adress på en öppen
   sajt? SCB:s sida nämner varken licens eller publicering (CC0 gäller SCB:s övriga öppna data).
   Läs villkoren tillsammans med användaren innan något publiceras.
2. **Variablerna**: finns reklamspärr som fält i API:et? Hur ser besöksadressen ut (gata, nummer,
   postnr, ort, ev. koordinater)? Finns organisationsnummer för företaget på varje arbetsställe?
   PDF:erna kunde inte läsas i förra sessionen (ingen PDF-läsare på datorn): hämta dem igen och läs
   med Read-verktyget, eller be användaren klistra in texten.
3. **Endpoints och format**: läs SCB:s API-dokumentation; gissa inte.

## Regler som gäller (från CLAUDE.md, tillämpade här)

- Visa **bara arbetsställen som tillhör juridiska personer**. Enskilda firmor (personnummer) läses
  aldrig in: använd `normOrgnr` i `lib/db.mjs`, som avvisar personnummer, och hoppa över raden.
- **Uteslut arbetsställen med reklamspärr**, om fältet finns. Annars: fråga användaren.
- Visa bara hyresgäster på fastigheter som finns i Horos (juridisk ägare). `build-public.mjs` ska bara
  ta med arbetsställen på tillåtna fastigheter, och `PUBLIC_MODE`-kontrollen i `server.mjs` bör vägra
  starta om ett arbetsställe tillhör en fysisk person.
- Det är ett API avsett för nedladdning, inte en e-tjänst, så hämtningen bryter inte mot regeln om
  bulkhämtning från e-tjänster. Håll ändå hastighetsgränsen och hämta per kommun.
- Texten på sajten ska säga vad det är: "Företag med arbetsställe på adressen (SCB)". Det är inget
  hyresavtal. Lägg till källan på metodsidan och i Om-panelen.

## Föreslagen lösning (minsta som räcker)

1. **Schema** (`lib/db.mjs`): tabellen `arbetsstalle` (cfar PRIMARY KEY, orgnr, namn, sni, storleksklass,
   gata, nummer, postnr, ort, lon, lat, beteckning, demo). Index på beteckning och orgnr.
2. **Import** `scripts/import-arbetsstallen.mjs` (följ mönstret i `import-adresser.mjs` och `import-bolag.mjs`):
   hämta per kommun, filtrera bort personnummer, reklamspärr och ej verksamma, och spara.
   `--dry` först, som de andra skripten.
3. **Koppla till fastighet**: via besöksadressen.
   - Har SCB koordinater: punkt-i-polygon med `fastighetVid(lon, lat)` i `server.mjs`. Flytta den till
     `lib/geo.mjs` om importskriptet behöver den.
   - Annars: slå upp adressen i tabellen `adress` (OSM nu, Lantmäteriets belägenhetsadresser senare),
     sedan punkt-i-polygon.
   - Räkna och logga hur många som inte gick att koppla.
4. **API**: lägg `hyresgaster` i svaret från `/api/fastighet/:bet` (namn, orgnr, SNI-text, storleksklass,
   adress) och `arbetsstallen` i `/api/bolag/:orgnr` (var bolaget sitter).
5. **Panel** (`public/app.js`, `openFastighet`): rubriken "Företag på adressen", en tabell per adress som
   hos Datscha, länk till bolagspanelen. Sortera efter storleksklass.
6. **Lokalanvändning**: tills Byggnad är beviljad, visa en uppskattning från branscherna (t.ex. andel
   anställda inom kontorsbranscher eller lager och partihandel), tydligt märkt som uppskattning. När
   Byggnad beviljas: ändamål som "Användning" före taxeringstypen (står redan i CLAUDE.md).
7. **SNI-texter**: SCB publicerar SNI som öppen kodlista. Kontrollera vilken version registret använder
   (SNI 2007 eller den nyare SNI 2025), spara som en liten tabell eller JSON och översätt koderna till klartext.
8. **Filter och kartfärg** (senare): "Bransch" i filtret och "Färga efter: bransch" bygger på samma tabell.
9. **Tester**: lägg till arbetsställen i `before()` i `test/server.test.mjs`, inklusive ett med
   personnummer och ett med reklamspärr, och kontrollera att de inte syns.
10. **Demo-data**: `scripts/demo-data.mjs` bör få påhittade arbetsställen så att panelen går att prova.

## Inte gjort i förra sessionen (andra spår)

- Kommunens plandokument (länk) väntar på att kolumnerna i planfilen är kända.
- Under zoom 10 visas inga fastigheter (behöver förberäknade kluster för hela landet).
- Commitarna är inte pushade till GitHub.
- Publicera rättningarna: `& "C:\Program Files\Git\bin\bash.exe" deploy/deploy.sh deploy@37.27.152.172`
  i användarens terminal (lösenfras).
