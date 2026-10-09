# Överlämning 2026-10-10

Läs `CLAUDE.md` först (regler, teknik, server). Den här filen sammanfattar sessionen 2026-10-10 och
det som ska kommas ihåg när data kommer. Detaljer om SCB:s arbetsställen står i `OVERLAMNING-hyresgaster.md`.

## Läget

- Allt är committat på `master`, inget är pushat till GitHub och inget nytt är publicerat. Live
  (http://37.27.152.172) går till och med d7585fa; allt därefter är bara lokalt.
- `npm test`: 18 gröna tester (`test/server.test.mjs`, `arbetsstallen`, `typkoder`, `db`, `geo`, `import-planer`).
- Prova lokalt: `preview_start {name: "horos-3005"}`. Exempeldata: `node scripts/demo-data.mjs` (hämtar
  byggnader från Overpass, påhittade ägare, arbetsställen och tomträtter).
- Publicera: `& "C:\Program Files\Git\bin\bash.exe" deploy/deploy.sh deploy@37.27.152.172` i användarens
  terminal (lösenfras). Publiceras först när användaren vill; den publika databasen har fortfarande 0 fastigheter.

## Byggt 2026-10-10

- **Företag på adressen** (SCB:s företagsregister, arbetsställen): import `scripts/import-arbetsstallen.mjs`,
  tabell `arbetsstalle`, panel per adress, "Arbetsställen i Horos" i bolagspanelen. Se `OVERLAMNING-hyresgaster.md`.
- **Rutan Användning** i fastighetspanelen: taxeringstyp + uppskattad fördelning på sju lokaltyper med stapel
  och uppskattad LOA (anställda × m² per anställd, `LOKALTYPER`/`AVDELNINGAR` i `server.mjs`, räknas i SQL).
- **Nyckeltal**: Tomtareal (tidigare "Areal"), LOA/BOA (uppskattad LOA, BOA saknas), exploateringstal
  (uppskattad LOA / tomtareal, utan BOA), Upplåtelseform.
- **Upplåtelseform**: kolumn `agande.tomtratt` (1 tomträtt, 0 lagfart, null okänt; läggs till automatiskt i
  äldre databaser). Okänt visas som "uppgift saknas", aldrig som äganderätt. Tomträttshavaren visas först.
- **Typkoder**: `lib/typkoder.mjs` (Skatteverkets lista, med gamla texter per taxeringsår); import-taxering
  sparar klartext och listar okända koder.
- **Filter**: län och kommun (`lib/kommuner.mjs` från SCB, kartan zoomar dit), ägare (namn eller org.nr),
  ägarkategori (stat, kommun, region, fastighetsbolag = SNI 68, brf, övriga), lokalslag, upplåtelseform,
  tomtyta från/till, uppskattad LOA från/till. Allt i den delbara adressen; formuläret scrollar.
- Rättat: hovringsrutan kraschade på enheter utan mus.

## Kom ihåg när data kommer

- **Lantmäteriet (lagfarter/ägare): tomträttsinnehav är INTE efterfrågat.** Begäran gäller lagfarter,
  köpeskillingar och nuvarande juridiska ägare. Kontrollera när filen kommer om den har tomträttsinnehav
  eller en kolumn för upplåtelseform (import-lagfarter letar efter `upplatelseform`, `tomtratt`,
  `inskrivningstyp` m.fl., annars `--map tomtratt=<kolumn>`). Saknas det: begär tomträttsinnehav
  (innehavare och upplåtelseform) separat. Utan det visar rutan Upplåtelseform "uppgift saknas" överallt.
- **Skatteverket (taxering)**: kontrollera att typkoden finns (och om den kommer som "325.0" från Excel),
  att specialenheter (8xx, skattefria, utan värde) är med, och om lokalyta/boyta (LOA/BOA) finns. Finns
  ytorna ska de ersätta den uppskattade LOA:n och fylla i BOA och exploateringstalet.
- **SCB API-nyckel**: användaren registrerar sig med BankID på https://registreraafr.scb.se/ och läser
  villkoren (publicering per adress?). Sedan `npm run import:arbetsstallen -- --dry`; `build-public
  --scb-villkor` först när villkoren tillåter det.
- **Byggnad (Lantmäteriet)**: byggnadernas ändamål ska ersätta lokaltyperna från branscherna.

## Idéer och kända brister

- Kommunalt och statligt ägda aktiebolag hamnar under Fastighetsbolag/Övriga. SCB:s juridiska enheter
  (`/v1/juridiskaenheter`, samma API-nyckel) har ägarkontroll (statligt, kommunalt, privat, utländskt);
  med den kan ägarkategorierna bli rätt.
- Uppskattad LOA kan bli orimlig (stora arbetsgivare, lokaler utan företag). Tumreglerna står på metodsidan.
- Filtren räknar LOA och kategorier per fastighet i kartutsnittet vid varje anrop; inte mätt med verkliga
  datamängder. Förberäkna per fastighet om det blir långsamt.
- Län och kommun är bara provade med Stockholm (exempeldatan har en kommun).
