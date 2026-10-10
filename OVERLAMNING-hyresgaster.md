# Överlämning: hyresgäster och lokalanvändning i Horos

Skriven 2026-10-09 för en ny session. Läs `CLAUDE.md` först (regler, teknik, server). Den här filen
beskriver bara nästa arbete: visa **vilka företag som sitter i en fastighet** och **vad lokalerna
används till** (kontor, lager, butik …), som Datscha/Property Intel gör.

## Läget

- Aktuellt läge (commits, tester, publicering): se `OVERLAMNING.md` (2026-10-10). Det som är byggt för
  arbetsställena står under "Byggt 2026-10-10" nedan.

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
- **Reklamspärr**: företaget har frånsagt sig reklam via post, e-post och telefon (inte exponering).
- Källor: <https://www.scb.se/vara-tjanster/bestall-data-och-statistik/foretagsregistret/avgiftsfria-uppgifter-i-foretagsregistret/>,
  variabelbeskrivning (PDF): <https://www.scb.se/contentassets/8a8eb5c3d45f461ea93482f8e8d4de4f/variabelbeskrivning-api.pdf>,
  postbeskrivning arbetsställen (postbeskrivning-ae.pdf, länkas från samma sida).

## Öppna frågor (1 kvar)

1. **Användarvillkoren – besvarad 2026-10-10** (lästa med användaren i Registreringsportalen):
   - Nyttjanderätt: får användas och spridas utan andra begränsningar än att källa anges: "SCB" eller
     "Statistiska centralbyrån", vid bearbetning med tillägget att egen bearbetning gjorts. Horos skriver
     "SCB, företagsregistret (egen bearbetning)" (`SCB_KALLA` i public/panel.js).
   - Reklamspärr: "Vid vidarespridning av uppgifter svarar Användaren för att informera om reklamspärrar."
     Alltså markera, inte utesluta. Horos sparar `reklamsparr` och visar etiketten "reklamspärr".
   - GDPR gäller personuppgifter (vi tar inte in enskilda firmor); överföring bara inom EU/EES.
   (Ursprunglig fråga: får uppgifterna publiceras per adress på en öppen
   sajt? SCB:s sida nämner varken licens eller publicering (CC0 gäller SCB:s övriga öppna data).
   Läs villkoren tillsammans med användaren innan något publiceras.
   Registreringen sker med BankID på https://registreraafr.scb.se/; villkoren syns först efter inloggning.
2. **Variablerna – besvarad 2026-10-10** (postbeskrivning-ae.pdf, variabelbeskrivning-afr_261009.pdf):
   - `peOrgNr`: 12 siffror. Juridisk person = `16` + orgnr; enskild firma = personnummer (börjar 19/20).
     `normOrgnr` avvisar redan personnumren (tredje siffran efter sekelsiffrorna < 2).
   - `reklamSparrTyp`: 1 = tar emot reklam, **2 = har frånsagt sig reklam** (uteslut; kodtabellen `reklamsparrtypkoder`, kontrollerad 2026-10-10 – PDF:en sa 3/4). Även
     `telefonSparrTyp` (1 ej, 2 telemarketing, 3 Nix) och `epostSparrTyp` (1 ej, 2 spärrat); de gäller
     kontaktvägar vi ändå inte sparar.
   - `aeStat`: 0 aldrig verksam, 1 verksam, 9 ej längre verksam. `aeTyp` 3 = fiktivt arbetsställe
     (rörlig personal i kommuner) – uteslut. `hjVerksJE` 2 = hjälparbetsställe (t.ex. eget lager/huvudkontor).
   - `anstKl`: 0 uppgift saknas, 1 = 0, 2 = 1–4, 3 = 5–9, 4 = 10–19, 5 = 20–49, 6 = 50–99, 7 = 100–199,
     8 = 200–499, 9 = 500–999, 10 = 1000–1499, 11 = 1500–1999, 12 = 2000–2999, 13 = 3000–3999,
     14 = 4000–4999, 15 = 5000–9999, 16 = 10000–.
   - `belagenhetsadress`: `bGatuAdress` (gatunamn+nummer+bokstav+ev. "trappor" i ett fält), `bPostNr`,
     `bPostOrt`, `kommun` (4 siffror), `lan`. `ben` = arbetsställets populärnamn (kan vara tomt).
   - `geografiskInformation` (bara i `/full`): `nord/ostKoordinatSW` = **fastighetens mittpunkt**,
     `nord/ostKoordinatAdressSW` = adressens läge, båda SWEREF 99 (TM, heltal meter), uppdateras årligen.
     Använd adresskoordinaten med punkt-i-polygon; ingen adressmatchning behövs.
   - `naringsgrenar[]` (`naringsgren` 5 siffror, `rangordning`, `andelProcent`, `avdelningsKod`):
     **SNI 2025**, högst 5 per arbetsställe. Klartexter: `/v1/kodtabeller/naringsgrenkoder`.
   - Övrigt i posten som inte ska sparas: `tel`, `epost`, `postAdress`, `startDat`/`slutDat`.
3. **Endpoints – besvarad 2026-10-10** (öppen spec: https://apiafr.scb.se/swagger/v1/swagger.json):
   - Bas `https://apiafr.scb.se/v1/`, header `X-API-Key`. Sidor: `limit` (≤ 5000) + `cursorId` =
     föregående `pagination.nextCursorId`, tills `pagination.hasMore` är false. 429 vid för många anrop;
     otillgängligt 04:00–04:30.
   - `arbetsstallen/kommun/{kod}` och `/lan/{kod}` ger bara **partial** (inga koordinater, bara
     primär näringsgren). Koordinater finns bara i `arbetsstallen/full` (hela landet, svar
     `{pagination, arbetsstallen: [...]}`) och `arbetsstallen/{cfarNr}/full`.
     Väg: hämta `/full` för hela landet (några hundra anrop) och filtrera lokalt.
   - Kodtabeller under `/v1/kodtabeller/...` (naringsgrenkoder, anstklkoder, reklamsparrtypkoder …).

## Regler som gäller (från CLAUDE.md, tillämpade här)

- Visa **bara arbetsställen som tillhör juridiska personer**. Enskilda firmor (personnummer) läses
  aldrig in: använd `normOrgnr` i `lib/db.mjs`, som avvisar personnummer, och hoppa över raden.
- **Märk arbetsställen med reklamspärr** (`reklamSparrTyp` = 2) och förklara spärren på metodsidan (SCB:s villkor).
- Visa bara hyresgäster på fastigheter som finns i Horos (juridisk ägare). `build-public.mjs` ska bara
  ta med arbetsställen på tillåtna fastigheter, och `PUBLIC_MODE`-kontrollen i `server.mjs` bör vägra
  starta om ett arbetsställe tillhör en fysisk person.
- Det är ett API avsett för nedladdning, inte en e-tjänst, så hämtningen bryter inte mot regeln om
  bulkhämtning från e-tjänster. Håll ändå hastighetsgränsen (högst 5 anrop/s). Koordinater kräver `/full` för hela landet; spara bara rader på fastigheter i Horos.
- Texten på sajten ska säga vad det är: "Företag med arbetsställe på adressen (SCB)". Det är inget
  hyresavtal. Lägg till källan på metodsidan och i Om-panelen.

## Byggt 2026-10-10 (påhittade data, inte publicerat)

- Tabell `arbetsstalle` (lib/db.mjs), `scripts/import-arbetsstallen.mjs` (`npm run import:arbetsstallen`):
  hämtar `/v1/arbetsstallen/full` för hela landet sida för sida, utesluter personnummer, aeStat ≠ 1,
  aeTyp 3 och rader utan koordinater, märker reklamspärr (2), kopplar adresskoordinaten till fastighet. Sparar alla
  kvarvarande (även utan fastighet, `beteckning` null); `--dry` räknar bara. `--fil`/`--sni` för sparade svar.
- API: `hyresgaster` i `/api/fastighet/:bet`, `arbetsstallen` i `/api/bolag/:orgnr`.
- Ruta "Användning" (under Ägare/Senaste köp): taxeringstyp + uppskattad fördelning på 7 lokaltyper med
  stapel och uppskattad LOA (anställda × m²/anställd i `LOKALTYPER` i lib/lokaltyp.mjs, sparas per arbetsställe vid
  importen och summeras som `anvandning`; tumregler, även på metodsidan). Samma kolumner ger kartfiltren Lokalslag (`lok`) och LOA (`loamin`/`loamax`).
- Panel: "Företag på adressen" per adress med bransch och storleksklass, "Uppskattad användning från
  branscherna" (SNI-avdelning → lokaltyp, viktat med anställda), "Arbetsställen i Horos" i bolagspanelen.
  Källa i Om-panelen och på metodsidan.
- build-public tar bara med arbetsställen med `--scb-villkor`, bara på tillåtna fastigheter, aldrig personnummer.
  PUBLIC_MODE vägrar starta med arbetsställen med personnummer eller utan fastighet i Horos.
- Påhittade arbetsställen i demo-data. Tester: `test/arbetsstallen.test.mjs` + ett i `test/server.test.mjs` (16 totalt).

### När nyckeln finns
1. Användaren sätter nyckeln i sin terminal (skrivs aldrig i chatten): `$env:SCB_API_KEY = Read-Host -MaskInput`,
   eller kör skriptet utan variabel så frågar det dolt.
2. `npm run import:arbetsstallen -- --dry` först. Kontrollera att fältnamnen stämmer (antal "utan koordinater"
   ska vara litet, branscher ska ha klartext). Ändra i `rad()` om svaret skiljer sig från specen.
3. Kontrollera SNI 2025-avdelningarna i `AVDELNINGAR` (lib/lokaltyp.mjs) mot `avdelningText` i kodtabellen.
4. ~~Läs SCB:s villkor~~ (gjort 2026-10-10, se ovan); därefter `build-public --scb-villkor`.

## Föreslagen lösning (ursprunglig plan)

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
