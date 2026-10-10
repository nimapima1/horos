# Överlämning 2026-10-10 (kväll)

Läs `CLAUDE.md` först (regler, teknik, server) och `PRIVAT.md` (inte i git: mejlkontakter, myndighetsärenden,
kostnader). Den här filen beskriver läget efter sessionerna 2026-10-10 och vad som ska göras härnäst.
Detaljer om SCB:s arbetsställen (API, fält, koder, villkor) står i `OVERLAMNING-hyresgaster.md`.

## Läget

- **Publikt repo**: https://github.com/nimapima1/horos (AGPL-3.0-or-later). Allt är committat och pushat
  (`master` = `origin/master`). Sådant som inte ska vara publikt (namngivna personers adresser, förhandlingsläge,
  kostnader, nycklar) läggs i `PRIVAT.md`. Äldre commits innehåller fortfarande mejlutkast och mottagaradresser
  (015a319, 8fa017e); historiken skrivs **inte** om (beslut 2026-10-10: redaktionernas publika adresser, redan pushat).
- **Live**: https://horos.se och https://www.horos.se (skickas vidare), HTTPS med Let's Encrypt. Koden till och
  med b8fd5c8, publik databas byggd 2026-10-10 14:25 med `--alla-bolag` och publicerad med `--data`:
  0 fastigheter, 2,2 miljoner bolag (ägarkontrollen som ord: `stat`, `kommun`, `region` …), 120 177 adresser,
  127 affärer ur pressmeddelanden, inga arbetsställen (byggt utan `--scb-villkor`).
- `npm test`: 31 gröna. Prova lokalt: `preview_start {name: "horos-3005"}` (autoPort; port 3005 kan vara upptagen
  av en annan session). Starta om servern efter import eller demo-data.
- Publicera: `& "C:\Program Files\Git\bin\bash.exe" deploy/deploy.sh deploy@37.27.152.172 [--data]` i användarens
  terminal (lösenfras **direkt**, annars stänger servern anslutningen). Deploy laddar upp arbetskatalogen som den
  är: kontrollera `git status` först så att ingen annan sessions ocommittade ändringar följer med.

## Gjort 2026-10-10

- **Kommunöversikt** under zoom 10: `/api/kommunkluster` (antal per kommun i hela landet med kartfiltren,
  sparas per filter i minnet), bubblor som slås ihop när man zoomar ut.
- **Pressmeddelanden** (`lib/nyheter.mjs`, `scripts/import-nyheter.mjs`): 14 nyhetsrum på Cision, bara rubrik,
  länk, datum, typ, pris, kommun och platser (aldrig texten). Listor i Affärer och fastighetspanelen.
  Granskat två gånger (ponytail-review, code-review max); bland annat: bara en *köpande* privatperson stoppar
  affären, platser publiceras bara på tillåtna fastigheter (inga lösa adresspunkter), adressen måste ligga i
  kommunen texten nämner, valutan som nämns först avgör utlandsaffär, hyresvärdet blir inte pris.
- **Domän** horos.se hos Loopia (LoopiaDNS), A-post för `@` och `www` mot servern. www skickas vidare av Caddy
  (cloud-init v4; på servern inlagt för hand som root, se CLAUDE.md). `kontakt@horos.se` vidarebefordras till
  Gmail, och Gmail skickar som adressen; SPF inkluderar Google.
- **Hetzner-kontot** hade huvudadress på jobbmejlen (Micasa); användaren har bytt den 2026-10-10.
- **SCB** (annan session): arbetsställen och ägarkontroll importerade lokalt, villkoren lästa (se nedan och
  `OVERLAMNING-hyresgaster.md`).

## Väntar på svar

- **Mejlen om tillstånd är skickade 2026-10-10** från `kontakt@horos.se` (Fastighetsvärlden, Fastighetsnytt,
  Modular Finance/MFN; mottagare i `PRIVAT.md`). Svaren kommer till Gmail via `kontakt@horos.se`.
  - Ja från MFN: lägg till MFN-flöden (`mfn.se/all/a/<bolag>.rss`) som källa i `lib/nyheter.mjs`; de flesta
    noterade fastighetsbolagen finns där. Följ deras villkor (källa, hämtfrekvens).
  - Ja från en tidning: bara rubrik + länk + det vi själva läser ut; ingen artikeltext, inget bakom betalvägg.
  - Fastighetsnytt fick också frågan om vem som svarar för DI (samma koncern, Bonnier News).
- Skatteverket, Lantmäteriet (lagfarter, geodatasupport) och Geotorget-ärendena: se `CLAUDE.md` och `PRIVAT.md`.

## Förslag till nästa session

1. Inga svar på tillståndsmejlen ännu (kollat i Gmail 2026-10-10 eftermiddag).
2. Pressmeddelanden hämtas på servern två gånger om dagen sedan 2026-10-10 (cron som deploy, se CLAUDE.md).
   Kontrollera `nyheter.log` efter första körningen:
   `ssh deploy@37.27.152.172 tail /var/lib/fastighetskarta/nyheter.log` (och `crontab -l`).
3. Schemalagd SCB-import: vänta tills fastigheterna finns (arbetsställena publiceras bara på tillåtna
   fastigheter och med `--scb-villkor`, så i dag ger det inget). Nyckeln är personlig och
   `secrets.env` kan inte läsas av deploy; fråga användaren hur den ska förvaras.
4. Planer: länk till kommunens plandokument när kolumnerna i planfilen är kända.

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
- Behörighetskontrollen stoppar Claude från köp, DNS-ändringar, `git push` och root-kommandon på servern:
  användaren gör dem (Loopia, Hetzners konsol, terminalen) och Claude kontrollerar resultatet.
- Hetzners webbkonsol tappar Skift vid inklistring; se CLAUDE.md (Server).

## Kända brister

- Pressmeddelandena tolkas med regler (regexar): fastigheter kan saknas eller bli fel, och priset är bolagets
  uppgift (ofta underliggande fastighetsvärde). Felaktiga kandidatbeteckningar syns aldrig, eftersom bara
  beteckningar som finns bland de tillåtna fastigheterna publiceras.
- `/api/kommunkluster` räknar över alla fastigheter vid första anropet med ett nytt filter; inte mätt med
  rikstäckande data (förberäkna i build-public om det blir långsamt).
- Uppskattad LOA kan bli orimlig (stora arbetsgivare, lokaler utan företag); tumreglerna står på metodsidan.
- Filtren räknar per fastighet i kartutsnittet vid varje anrop; län och kommun är bara provade med Stockholm.
