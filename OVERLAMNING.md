# Överlämning 2026-10-10 (eftermiddag)

Läs `CLAUDE.md` först (regler, teknik, server) och `PRIVAT.md` (inte i git: mejlkontakter, myndighetsärenden,
kostnader). Den här filen beskriver läget efter sessionerna 2026-10-10 och vad som ska göras härnäst.
Detaljer om SCB:s arbetsställen (API, fält, koder, villkor) står i `OVERLAMNING-hyresgaster.md`.

## Läget

- **Publikt repo**: https://github.com/nimapima1/horos (AGPL-3.0-or-later, `LICENSE`). Allt committat är pushat
  (`master` följer `origin/master`). Skrivs sådant som inte ska vara publikt (namngivna personers adresser,
  förhandlingsläge, kostnader, nycklar): lägg det i `PRIVAT.md`. Äldre commits innehåller fortfarande det som
  flyttades dit; historiken är inte omskriven.
- **Live**: https://horos.se kör koden till och med 358f3f5 (deployad 2026-10-10, bara kod, ingen ny databas).
  Den publika databasen har fortfarande 0 fastigheter, alltså inga arbetsställen heller.
- **Ej committat från en annan session** (horos.se/www): `CLAUDE.md` (två rader), `deploy/DEPLOY.md`,
  `deploy/cloud-init.yaml`. Rör dem inte utan att fråga; de är inte pushade.
- `npm test`: 24 gröna.
- Prova lokalt: `preview_start {name: "horos-3005"}`. Lokala databasen har nu **777 708 riktiga arbetsställen
  från SCB** (hela landet) ovanpå demo-fastigheterna; 10 825 av dem hamnar på demo-fastigheter, vilket bara
  är ett sammanträffande av koordinaterna. Starta om servern efter import eller demo-data.
- Publicera: `& "C:\Program Files\Git\bin\bash.exe" deploy/deploy.sh deploy@37.27.152.172 [--data]` i
  användarens terminal (lösenfras inom ett par minuter). Den här datorns DNS hittade inte horos.se direkt
  efter köpet; kontrollera med `curl --resolve horos.se:443:37.27.152.172 https://horos.se/`.

## Gjort denna session: SCB-arbetsställen på riktigt

- Nyckeln fungerar. Den sparas ingenstans: användaren klistrar in den (högerklick, inte Ctrl+V) när
  `import-arbetsstallen` frågar. `lib/prompt.mjs` tar bort markörer och styrtecken från inklistrad text.
- Importen (`--dry` först, `--sidor N` för prov): 1 917 910 lästa, 777 708 sparade, 8 042 med reklamspärr;
  uteslutna 632 373 enskilda firmor, 398 963 ej verksamma, 290 fiktiva, 108 576 utan koordinater.
- **Reklamspärr är kod 2** (kodtabellen), inte 4 som PDF:en sa. Övriga koder och SNI-avdelningarna är
  kontrollerade mot kodtabellerna.
- **SCB:s villkor lästa** (Registreringsportalen, efter BankID): fri spridning med källa; vid bearbetning
  "egen bearbetning". Den som sprider uppgifterna ska **informera om reklamspärr** (inte utesluta). Därför:
  kolumnen `arbetsstalle.reklamsparr`, etiketten "reklamspärr" i panelerna med förklaring när någon har spärr,
  text på metodsidan, källan `SCB_KALLA` = "SCB, företagsregistret (egen bearbetning)" i `public/panel.js`.
- Granskat med thermo-nuclear och ponytail-review; alla fem fynd fixade (358f3f5).

## Kom ihåg när data kommer

- **Lantmäteriet (lagfarter/ägare): tomträttsinnehav är INTE efterfrågat.** Kontrollera när filen kommer om
  den har tomträttsinnehav eller en kolumn för upplåtelseform (import-lagfarter letar efter `upplatelseform`,
  `tomtratt`, `inskrivningstyp` m.fl., annars `--map tomtratt=<kolumn>`). Saknas det: begär tomträttsinnehav
  (innehavare och upplåtelseform) separat. Annars visar rutan Upplåtelseform "uppgift saknas" överallt.
- **När fastigheterna finns**: kör `import-arbetsstallen` igen (kopplingen till fastighet görs vid importen)
  och bygg med `build-public --scb-villkor` (+ `--alla-bolag`, `--lm-beslut` osv.), deploy med `--data`.
- **Skatteverket (taxering)**: kontrollera typkoden (och "325.0" från Excel), att specialenheter (8xx) är med,
  och om lokalyta/boyta finns. Då ska de ersätta uppskattad LOA och fylla i BOA och exploateringstalet.
- **Byggnad (Lantmäteriet)**: byggnadernas ändamål ska ersätta lokaltyperna från branscherna.
- Vid varje import: `--dry` först, påminn om åtagandena (bara juridiska personer), bygg med build-public.

## Förslag till nästa session

1. Ägarkontroll från SCB (`/v1/juridiskaenheter`, nyckeln finns nu), så att kommunägda och statligt ägda
   bolag hamnar under Kommun/Staten i ägarkategorin (i dag Fastighetsbolag/Övriga).
2. Schemalagd SCB-import på servern (registret uppdateras varje natt): kräver att nyckeln läggs i
   `/etc/fastighetskarta/secrets.env` (som Geotorget, via `login-till-server`) och ett jobb utanför 04:00–04:30.
   Fråga användaren först; nyckeln är personlig.
3. Pressmeddelanden behöver också ett schemalagt jobb (se CLAUDE.md).
4. Planer: länk till kommunens plandokument när kolumnerna i planfilen är kända.

## Tips för arbetet

- I PowerShell blockeras `npm` (execution policy): kör `& "C:\Program Files\nodejs\node.exe" scripts/…` direkt.
- Bash-verktyget gör om `\\` i heredocs; redigera filer med Edit/Write när ersättningen har backslash.
- Flera filer har CRLF i arbetskopian (git normaliserar); Edit-verktyget klarar det.

## Kända brister

- Uppskattad LOA kan bli orimlig (stora arbetsgivare, lokaler utan företag); tumreglerna står på metodsidan.
  Byggverksamhet (SNI F) räknas som Industri, vilket kan diskuteras.
- Filtren räknar per fastighet i kartutsnittet vid varje anrop; inte mätt med verkliga datamängder.
- Län och kommun är bara provade med Stockholm (exempeldatan har en kommun).
- `--sidor` har inget automatiskt test (testerna läser fil, inte API:t); provat mot SCB 2026-10-10.
