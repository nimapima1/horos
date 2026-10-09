# Överlämning 2026-10-10

Läs `CLAUDE.md` först (regler, teknik, server). Den här filen beskriver läget efter sessionen 2026-10-10,
var koden ligger nu och vad som ska göras härnäst. Detaljer om SCB:s arbetsställen (API, fält, villkor)
står i `OVERLAMNING-hyresgaster.md`.

## Läget

- Allt är committat på `master` (senast 3d3fa1c). Inget är pushat till GitHub och inget nytt är publicerat:
  live (http://37.27.152.172) går till och med d7585fa. Opublicerat: 2639294, aaa718c, ac7e76d, d9a7daf,
  a2c9e9d, 2239814, 25ba400, 3d3fa1c. Den publika databasen har fortfarande 0 fastigheter.
- `npm test`: 19 gröna (`server`, `arbetsstallen`, `lokaltyp`, `typkoder`, `db`, `geo`, `import-planer`).
- Prövat i webbläsarpanelen på desktop och emulerad mobil (375×812); inte på riktig iOS.
- Prova lokalt: `preview_start {name: "horos-3005"}`. Exempeldata: `node scripts/demo-data.mjs` (hämtar
  byggnader från Overpass, som ibland svarar 504: kör igen). Servern läser vid start om det finns
  arbetsställen, typer och kommuner, så **starta om den efter import eller demo-data**.
- Publicera (när användaren vill): `& "C:\Program Files\Git\bin\bash.exe" deploy/deploy.sh deploy@37.27.152.172`
  i användarens terminal (lösenfras inom ett par minuter).

## Var koden ligger (ändrat denna session)

- `server.mjs`: `FILTER` är `[parameter, omvandling, SQL-villkor]` och WHERE-delen byggs ur listan; nytt filter =
  en rad. `UPPLATELSE` (tomträtt/äganderätt i en underfråga), `AGARKATEGORI_SQL`, `status` skickar `foretag`,
  `lokaltyper`, `agarkategorier`, `upplatelseformer`, `lan`, `kommunInfo`.
- `lib/lokaltyp.mjs`: arbetsställe → lokaltyp och uppskattad LOA (tumregler). Sparas i `arbetsstalle.lokaltyp`
  och `.loa_m2` av import och demo-data; ändrade regler kräver ny import.
- `lib/typkoder.mjs` (Skatteverkets typkoder per taxeringsår), `lib/kommuner.mjs` (SCB:s län och kommuner).
- `lib/db.mjs`: `openDb` lägger till nya kolumner i äldre databaser (`agande.tomtratt`, `arbetsstalle.lokaltyp`,
  `.loa_m2`), sist i tabellen så att `SELECT *` i build-public stämmer.
- `public/panel.js`: panelvyerna (fastighet, bolag, Om, Affärer, Ägare). Bara deklarationer, laddas **före**
  `app.js`; `app.js` har karta, filter, sök, status och all inkoppling (länkar, routning).
- `scripts/import-arbetsstallen.mjs` (SCB), `import-lagfarter --som agare` läser tomträtt om kolumnen finns.

## Byggt 2026-10-10 (för användaren)

- Företag på adressen (SCB-arbetsställen) och arbetsställen i bolagspanelen; visas bara när uppgifterna finns.
- Rutan Användning: lokaltyper med stapel, andel av yta och uppskattad LOA; nyckeltalen Tomtareal, LOA/BOA,
  Exploateringstal och Upplåtelseform (tomträtt/äganderätt; okänt visas aldrig som äganderätt).
- Filter: län, kommun (kartan zoomar dit), ägare, ägarkategori, lokalslag, upplåtelseform, tomtyta och LOA
  från/till, plus de gamla. Allt i den delbara adressen; formuläret scrollar.
- Typkoder blir klartext vid import av taxering. Rättat: hovringsrutan på enheter utan mus.

## Kom ihåg när data kommer

- **Lantmäteriet (lagfarter/ägare): tomträttsinnehav är INTE efterfrågat.** Kontrollera när filen kommer om
  den har tomträttsinnehav eller en kolumn för upplåtelseform (import-lagfarter letar efter `upplatelseform`,
  `tomtratt`, `inskrivningstyp` m.fl., annars `--map tomtratt=<kolumn>`). Saknas det: begär tomträttsinnehav
  (innehavare och upplåtelseform) separat. Annars visar rutan Upplåtelseform "uppgift saknas" överallt.
- **Skatteverket (taxering)**: kontrollera typkoden (och "325.0" från Excel), att specialenheter (8xx) är med,
  och om lokalyta/boyta finns. Då ska de ersätta uppskattad LOA och fylla i BOA och exploateringstalet.
- **SCB API-nyckel**: användaren registrerar sig med BankID på https://registreraafr.scb.se/ och läser villkoren
  (publicering per adress?). Sedan `npm run import:arbetsstallen -- --dry`, kontrollera fältnamnen och
  `AVDELNINGAR` i `lib/lokaltyp.mjs` mot SCB:s kodtabell. `build-public --scb-villkor` först när villkoren tillåter.
- **Byggnad (Lantmäteriet)**: byggnadernas ändamål ska ersätta lokaltyperna från branscherna.
- Vid varje import: `--dry` först, påminn om åtagandena (bara juridiska personer), bygg med build-public.

## Förslag till nästa session

1. Publicera det som finns (kod; databasen är fortfarande tom på fastigheter) om användaren vill.
2. Pusha till GitHub (inte gjort på länge).
3. När SCB-nyckeln finns: ägarkontroll från `/v1/juridiskaenheter`, så att kommunägda och statligt ägda
   bolag hamnar under Kommun/Staten i ägarkategorin (i dag Fastighetsbolag/Övriga).
4. Planer: länk till kommunens plandokument när kolumnerna i planfilen är kända (se CLAUDE.md, Att göra).

## Kända brister

- Uppskattad LOA kan bli orimlig (stora arbetsgivare, lokaler utan företag); tumreglerna står på metodsidan.
- Filtren räknar per fastighet i kartutsnittet vid varje anrop; inte mätt med verkliga datamängder.
- Län och kommun är bara provade med Stockholm (exempeldatan har en kommun).
