# Överlämning 2026-10-11

Läs `CLAUDE.md` först (regler, teknik, server) och `PRIVAT.md` (inte i git: mejlkontakter, myndighetsärenden,
kostnader). Den här filen beskriver läget efter sessionerna 2026-10-10 och vad som ska göras härnäst.
Detaljer om SCB:s arbetsställen (API, fält, koder, villkor) står i `OVERLAMNING-hyresgaster.md`.

## Läget

- **Publikt repo**: https://github.com/nimapima1/horos (AGPL-3.0-or-later). Allt är committat och pushat
  (`master` = `origin/master`). Sådant som inte ska vara publikt (namngivna personers adresser, förhandlingsläge,
  kostnader, nycklar) läggs i `PRIVAT.md`. Äldre commits innehåller fortfarande mejlutkast och mottagaradresser
  (015a319, 8fa017e); historiken skrivs **inte** om (beslut 2026-10-10: redaktionernas publika adresser, redan pushat).
- **Live**: https://horos.se och https://www.horos.se (skickas vidare), HTTPS med Let's Encrypt.
  - Koden till och med df2dee1 (deployad 2026-10-10 22:04 UTC).
  - Publik databas byggd 2026-10-10 14:25 med `--alla-bolag`, publicerad med `--data`: 0 fastigheter,
    2,2 miljoner bolag (ägarkontrollen som ord: `stat`, `kommun`, `region` …), 120 177 adresser, inga
    arbetsställen (byggt utan `--scb-villkor`), 127 affärer ur pressmeddelanden (uppdateras av cron).
  - Servern: cloud-init v3 + ändringarna i v4–v5 inlagda för hand (www-blocket, inget `Via`-huvud,
    `set-secret` utan längdutskrift). Root-lösenordet återställdes 2026-10-10 (Hetzner > Rescue); användaren har det.
- `npm test`: 33 gröna. Prova lokalt: `preview_start {name: "horos-3005"}` (autoPort; port 3005 kan vara upptagen
  av en annan session). Starta om servern efter import eller demo-data.
- Publicera: `& "C:\Program Files\Git\bin\bash.exe" deploy/deploy.sh deploy@37.27.152.172 [--data]` i användarens
  terminal (lösenfras **direkt**, annars stänger servern anslutningen; det hände två gånger 2026-10-10). Deploy
  laddar upp arbetskatalogen som den är: kontrollera `git status` först så att ingen annan sessions ocommittade
  ändringar följer med.

## Gjort 2026-10-10 (eftermiddag och kväll)

- **Ny publik databas live**: ägarkontrollen är ord i stället för SCB:s sifferkoder (felet från förra överlämningen).
- **Pressmeddelanden hämtas på servern** (cron som `deploy`, 05:15 och 15:15 UTC, ingen root-ändring):
  - `deploy/nyheter.sh`: lås `databas.lock`, hoppar över om appen är stoppad, kopierar `public.sqlite`, kör
    `import-nyheter --publik` på kopian, byter filen och startar om **bara om något ändrades** (slutkod 3 = inget
    nytt), kontrollerar att appen svarar efteråt. Logg: `/var/lib/fastighetskarta/nyheter.log`.
  - `import-nyheter --publik` öppnar filen utan `openDb` (schemat skulle skapa `har_privat_agare` och WAL, och
    då vägrar servern starta). En adress som finns på flera ställen hoppas över publikt.
  - `deploy.sh --data` tar samma lås och behåller pressmeddelanden som bara finns på servern
    (`import-nyheter --publik <ny> --behall <gammal>`). Crontaben skrivs av `deploy.sh` vid varje deploy.
  - Regeln för publika platser är en enda: `NYHET_PLATS_UTANFOR` i `lib/db.mjs`, använd av build-public,
    importen och serverns spärr (publikt läge vägrar starta med en plats utan fastighet). Test i
    `test/nyheter-server.test.mjs`.
  - Provkört på servern 22:05 UTC: `127 affärer … (inget ändrades)`, ingen omstart.
- **Serverstädning** (cloud-init v5): Caddy skickar inte `Via`, `set-secret` skriver inte ut hemlighetens längd.
- **Granskning** av allt ovan (code-review max + ponytail-review): 11 fynd, alla åtgärdade i df2dee1.
- Gmail kollat 2026-10-10 kväll: inga svar på tillståndsmejlen.

## Väntar på svar

- **Mejlen om tillstånd är skickade 2026-10-10** från `kontakt@horos.se` (Fastighetsvärlden, Fastighetsnytt,
  Modular Finance/MFN; mottagare i `PRIVAT.md`). Svaren kommer till Gmail via `kontakt@horos.se`
  (sök t.ex. `to:kontakt@horos.se -from:me`).
  - Ja från MFN: lägg till MFN-flöden (`mfn.se/all/a/<bolag>.rss`) som källa i `lib/nyheter.mjs`; de flesta
    noterade fastighetsbolagen finns där. Följ deras villkor (källa, hämtfrekvens). Cron-jobbet tar med dem
    automatiskt när koden är deployad.
  - Ja från en tidning: bara rubrik + länk + det vi själva läser ut; ingen artikeltext, inget bakom betalvägg.
  - Fastighetsnytt fick också frågan om vem som svarar för DI (samma koncern, Bonnier News).
- Skatteverket, Lantmäteriet (lagfarter, geodatasupport) och Geotorget-ärendena: se `CLAUDE.md` och `PRIVAT.md`.
  Be användaren kontrollera att ansökan om **Byggnad** verkligen skickades (stod som "ifylld 2026-10-09").

## Förslag till nästa session

1. Kolla Gmail efter svar på tillståndsmejlen.
2. Läs `nyheter.log` på servern: `ssh deploy@37.27.152.172 tail /var/lib/fastighetskarta/nyheter.log`. Första
   gången ett nytt pressmeddelande kommer ska raden sakna `(inget ändrades)`; då har bytet och omstarten med
   kontroll körts på riktigt för första gången. Står det `Appen svarar inte efter omstarten`: se
   `fastighetskarta-admin logs 50`.
3. Nästa `deploy --data` är första gången `--behall` körs på riktigt: kontrollera raden
   `Behöll N pressmeddelanden som bara fanns på servern` i utskriften.
4. Schemalagd SCB-import: vänta tills fastigheterna finns (arbetsställena publiceras bara på tillåtna
   fastigheter och med `--scb-villkor`, så i dag ger det inget). Nyckeln är personlig och
   `secrets.env` kan inte läsas av deploy; fråga användaren hur den ska förvaras.
5. Planer: länk till kommunens plandokument när kolumnerna i planfilen är kända (filen finns inte i `data/raw/` än).

## Kom ihåg när data kommer

- **Lantmäteriet (lagfarter/ägare): tomträttsinnehav är INTE efterfrågat.** Kontrollera när filen kommer om den
  har tomträttsinnehav eller en kolumn för upplåtelseform (import-lagfarter letar efter `upplatelseform`,
  `tomtratt`, `inskrivningstyp` m.fl., annars `--map tomtratt=<kolumn>`). Saknas det: begär det separat.
- **När fastigheterna finns**: kör `import-arbetsstallen` och `import-nyheter` igen (kopplingen till fastighet
  görs vid importen) och bygg med `build-public --scb-villkor --alla-bolag --lm-beslut <nr>`, deploy med `--data`.
- **Skatteverket (taxering)**: kontrollera typkoden (och "325.0" från Excel), att specialenheter (8xx) är med,
  och om lokalyta/boyta finns; då ska de ersätta uppskattad LOA och fylla i BOA och exploateringstalet.
- **Byggnad**: ändamålen ska ersätta lokaltyperna från branscherna. **Belägenhetsadress**: byt OSM-adresserna.
- Vid varje import: `--dry` först, påminn om åtagandena (bara juridiska personer), bygg med build-public.

## Tips för arbetet

- I PowerShell blockeras `npm` (execution policy): kör `& "C:\Program Files\nodejs\node.exe" scripts/…` direkt.
- Bash-verktyget och Python i heredocs gör om `\\`, `\b` och `\n`; redigera filer med Edit/Write när texten har
  backslash. Kontrollera efteråt med `grep -c $'\x08'` att inga backspace-tecken hamnat i regexar.
- Den här datorns router cachar DNS länge: testa servern med `curl --resolve horos.se:443:37.27.152.172 …`.
- Behörighetskontrollen stoppar Claude från köp, DNS-ändringar och root-kommandon på servern: användaren gör dem
  (Loopia, Hetzners konsol, terminalen) och Claude kontrollerar resultatet. `git push` fungerade 2026-10-10 när
  användaren bad om det.
- SSH kräver lösenfrasen, så Claude kan inte själv köra kommandon på servern: ge kommandot, användaren kör det i
  terminalfliken, och Claude läser av fliken (`read_terminal`).
- Hetzners webbkonsol tappar Skift vid inklistring, även för versaler: skriv kommandon utan Skift-tecken
  (`.` i regexar, `\x53` för `S` i sed-ersättningar) och prova sed-raden lokalt på en kopia först.
- Subagenter (code-review max) kan stoppas av sessionsgränsen (429); gör då vinklarna själv.

## Kända brister

- Pressmeddelandena tolkas med regler (regexar): fastigheter kan saknas eller bli fel, och priset är bolagets
  uppgift (ofta underliggande fastighetsvärde). Felaktiga kandidatbeteckningar syns aldrig, eftersom bara
  beteckningar som finns bland de tillåtna fastigheterna publiceras.
- Publikt (cron) hoppas adresser som finns på flera ställen över, så servern visar ibland färre platser än en
  lokal import. Ett pressmeddelande som tagits bort lokalt kan komma tillbaka vid `--data` om det redan fallit ur
  Cisions flöde (ovanligt).
- Om cron-jobbet misslyckas syns det bara i `nyheter.log`; ingen avisering.
- `/api/kommunkluster` räknar över alla fastigheter vid första anropet med ett nytt filter; inte mätt med
  rikstäckande data (förberäkna i build-public om det blir långsamt).
- Uppskattad LOA kan bli orimlig (stora arbetsgivare, lokaler utan företag); tumreglerna står på metodsidan.
- Filtren räknar per fastighet i kartutsnittet vid varje anrop; län och kommun är bara provade med Stockholm.
