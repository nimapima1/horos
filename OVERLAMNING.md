# Överlämning 2026-10-12

Läs `CLAUDE.md` först (regler, teknik, server) och `PRIVAT.md` (inte i git: mejlkontakter, myndighetsärenden,
kostnader). Den här filen beskriver läget efter sessionerna 2026-10-10 och 2026-10-11 och vad som ska göras härnäst.
Detaljer om SCB:s arbetsställen (API, fält, koder, villkor) står i `OVERLAMNING-hyresgaster.md`.

## Läget

- **Publikt repo**: https://github.com/nimapima1/horos (AGPL-3.0-or-later). Allt är committat, pushat och mergat
  (`master` = `origin/master` = koden på horos.se). Sådant som inte ska vara publikt (namngivna personers adresser, förhandlingsläge,
  kostnader, nycklar) läggs i `PRIVAT.md`. Äldre commits innehåller fortfarande mejlutkast och mottagaradresser
  (015a319, 8fa017e); historiken skrivs **inte** om (beslut 2026-10-10: redaktionernas publika adresser, redan pushat).
- **Live**: https://horos.se och https://www.horos.se (skickas vidare), HTTPS med Let's Encrypt.
  - Koden till och med PR #11 (ca9be9e, mergad 2026-10-12: decimalkomma, Street View på mobil, scenariovyn på
    mobil), deployad 2026-10-12 08:45 och kontrollerad med curl (ny kod serveras, `vmin=1,5` ger 200). Ovanpå
    PR #8 (scenarier och ny panel, 9551e02) och PR #2–#7 från 2026-10-11: alltid mörkt läge, mobilrättningar, Förorenade och Utsatta
    områden, Google Maps och Street View.
  - Publik databas byggd 2026-10-10 14:25 med `--alla-bolag`, publicerad med `--data`: 0 fastigheter,
    2,2 miljoner bolag (ägarkontrollen som ord: `stat`, `kommun`, `region` …), 120 177 adresser, inga
    arbetsställen (byggt utan `--scb-villkor`), 127 affärer ur pressmeddelanden (uppdateras av cron).
  - Servern: cloud-init v3 + ändringarna i v4–v5 inlagda för hand (www-blocket, inget `Via`-huvud,
    `set-secret` utan längdutskrift), plus `frame-src https://www.google.com` i CSP:n (2026-10-11, i
    `/etc/caddy/Caddyfile.template` och `set-domain horos.se`). Root-lösenordet återställdes 2026-10-10
    (Hetzner > Rescue); användaren har det. Drop-in `fastighetskarta.service.d/scenarion.conf` (cloud-init v6,
    `StateDirectory=horos-scenarion`) inlagd 2026-10-11: korta länkar till scenarier är på.
  - `secrets.env`: GEOTORGET_USER/PASS och GOOGLE_EMBED_KEY.
- `npm test`: 44 gröna. Prova lokalt: `preview_start {name: "horos-3005"}` (autoPort; port 3005 kan vara upptagen
  av en annan session). Starta om servern efter import eller demo-data.
- Publicera: `& "C:\Program Files\Git\bin\bash.exe" deploy/deploy.sh deploy@37.27.152.172 [--data]` i användarens
  terminal (lösenfras **direkt**, annars stänger servern anslutningen; det hände två gånger 2026-10-10). Första
  försöket 2026-10-12 hann inte (lösenfrasen skrevs för sent); andra gick igenom. Ett avbrutet försök lämnar en flik
  som väntar på lösenfrasen och som Claude inte får stänga om användaren skrivit i den. Deploy
  laddar upp arbetskatalogen som den är: kontrollera `git status` först så att ingen annan sessions ocommittade
  ändringar följer med.

## Gjort 2026-10-12: mobilrättningar

- **Decimalkomma**: sifferfält med decimaler (Taxeringsvärde, Köpeskilling, alla i scenariot) är textfält med
  `inputmode="decimal"`, eftersom Safari/Firefox ger tomt värde för "4,5" i `type="number"`. Servern (`tal` i
  `FILTER`) och `scenarioInput` läser komma och mellanslag mellan tusental.
- **Street View på mobil**: rutan flyttas in i fastighetspanelen under adressen (`[data-streetview]`).
- **Scenariovyn på mobil**: antaganden per lokalslag som kort (rubrik via `data-rubrik`), fält 16 px/44 px,
  heldragen panel så att kassaflödets fasta kolumn inte får annan färg än glaset.
- **Granskning** (ponytail-review): sparade värden escapades inte i `talFalt` (HTML från en delad scenariolänk);
  rättat med `esc`.
- **Publicerat** 2026-10-12 08:45 från grenen, PR #11 mergad efteråt. Provat i webbläsarpanelen på 375 och 320 px och i
  datorvy; inte på riktig iPhone. Street View-knappen på mobil kan provas live först när fastigheterna finns.

## Gjort 2026-10-11 (sen kväll): Scenarier och ny panel (PR #8)

Idén kommer från Datschas "Scenarion" (användaren loggade in, Claude läste bara gränssnittet: ett scenario är en
sparad lista fastigheter med startår och kalkylperiod, schablonvärden per lokalslag från Newsec m.fl., kassaflöde,
nyckeltal). Horos version, utan inloggning och utan licensierade schabloner:

- **Kalkylen** (`public/kalkyl.js`, utan DOM, testad i `test/kalkyl.test.mjs`): hyra, vakans, drift och underhåll
  per lokalslag (Bostäder + `LOKALTYPER`), hyres- och kostnadsutveckling, fastighetsskatt (schablon från
  taxeringen, `shortcut:` för bostäder och blandade enheter) och tomträttsavgäld ger driftnettot; värdet är
  nuvärdet av perioden plus restvärde (driftnettot året efter / direktavkastningskravet). Kalkylränta =
  direktavkastningskrav + hyresutveckling om den inte anges. Nyckeltal: värde/m², direktavkastning, vakans- och
  DoU-tålighet (formlerna stämmer med Datschas exempel). **Horos har inga marknadshyror eller avkastningskrav**:
  fälten är tomma med exempel i grått, ytan är den uppskattade LOA:n eller användarens egen.
- **Vyn** (`public/scenario.js`, `#scenario`): namn, knappar (Spara och kopiera länk, Excel (CSV), Scenariofil,
  Mina scenarion, Stäng), nyckeltal, kassaflöde i tkr, antaganden (lokalslag utan yta under "Fler lokalslag"),
  fastigheterna med egna ytor/skatt/avgäld. Högst 1 000 fastigheter (`MAX_SCENARIO`).
- **Flera scenarier**: alla i `localStorage` (`horos.scenarion` med data, sparas vid varje ändring, högst 50,
  `shortcut:`); `horos.aktivt` är det öppna och läses in vid sidladdning. Varning i vyn om webbläsaren inte kan
  spara. **Lägga till**: + i fastighetspanelen (meny: välj scenario, bock där fastigheten finns, Nytt scenario);
  + i sökträffarna, "Lägg till i …" i bolagspanelen och i filtret lägger till i det öppna.
- **Dela**: `POST /api/scenario` sparar i en egen databas (`SCENARIO_DB`, annars `$STATE_DIRECTORY`, lokalt
  `data/scenarion.sqlite`); id = 10 tecken av sha256 av innehållet, så en länk `#s=<id>` ändras aldrig.
  Validering: `application/json` (skydd mot formulär från andra sidor), 256 kB, bara objekt/listor/korta
  strängar/tal, djup 5, egen hastighetsgräns `spara` (5 per 10 s), högst 200 000 scenarier. Utan skrivbar plats:
  `#sd=` med scenariot komprimerat i länken. `POST /api/underlag` ger fastigheterna (värde, typ, upplåtelse, LOA).
  Export: CSV (formelskydd för text som börjar med = + - @) och scenariofil (JSON) som kan öppnas igen.
- **Panelen**: Om/Metod/Data som små länkar uppe till höger; Filter, Transaktioner, Ägare och Scenarier som en
  flikrad under sökfältet (aktiv flik markerad, antal filter som bricka). Nyckeltal i fast rutnät.
  **Affärer heter Transaktioner** (`#transaktioner`; `#affarer` och `/api/affarer` finns kvar).
- **Granskning** (ponytail-review): 7 fynd, alla åtgärdade i baf8fec (fel scenario vid nätverksfel, CSV-formler,
  tyst misslyckad sparning, kolumnnamn, NaN i skatt, kommentar, test av länkformatet).

## Gjort 2026-10-11 (kväll): Google Maps och Street View (PR #5–#7)

- **Länkar** längst ner i fastighetspanelen: "Öppna i Google Maps · Street View" (Googles öppna URL-format, ingen
  nyckel, `noreferrer`). Punkten är mitten av fastighetens bbox (`mittpunkt` i `panel.js`; `shortcut:` för
  L-formade fastigheter). `/api/fastighet` skickar därför med `minx/miny/maxx/maxy`.
- **Street View-rutan**: kartkontroll under Detaljplaner (`StreetView` i `app.js`), syns bara när en fastighet är
  öppen och `GOOGLE_EMBED_KEY` finns (`/api/status` → `streetview`). Två klick: knappen "Street View" (förklaring i
  `title`), iframen (Maps Embed API, `referrerPolicy: strict-origin`) skapas först vid klick och följer sedan med
  till nästa fastighet tills "Stäng Street View". På mobil (under 641 px) flyttas rutan in i fastighetspanelen, under adressen (2026-10-12). I fönster under 700 px höjd
  döljs Färga efter medan rutan är utfälld.
- **Kartkontrollerna** Karta/Detaljplaner/Street View är lika breda (104 px); bakgrundens alternativ kortade till
  "Satellit 25" och "Foto 2005/1995/1975/1960" (ett längre namn kapas).
- **Integritetstexterna** (Om-vyn och `metod.html`) säger att Street View laddas från Google först vid klick.
- **Google Cloud**: användarens projekt (provperiod), Maps Embed API aktiverat, nyckeln låst till
  `horos.se/*` och bara Maps Embed API. Provat: nyckeln godtas med hänvisare horos.se och avvisas från andra
  webbplatser; på horos.se visade rutan riktig Street View (4 Riddargatan) via konsolen
  (`streetView.visa('59.335001,18.075138', (await statusP).streetview)`), eftersom live saknar fastigheter.
- Juridik i korthet (resonemang, inte juridisk rådgivning): visningen skickar IP och plats till Google LLC (USA,
  Data Privacy Framework). Därför två klick i stället för automatisk inbäddning; Horos är gemensamt ansvarig för
  insamlingen (Fashion ID).

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

0. **Scenarier**: tryck en gång på "Spara och kopiera länk" på horos.se och öppna länken i ett privat fönster
   (sparningen på servern är inte provad live, för att inte lämna ett testscenario kvar). Decimalkomma är rättat
   2026-10-12 men inte provat på riktig iPhone. När taxeringen kommer: ta ytor (LOA/BOA) och
   bostads-/lokalvärde därifrån i stället för uppskattningen och skatteschablonen. Möjliga nästa steg: öppna
   standardvärden (t.ex. SCB:s bostadshyror per kommun) och finansiering (lån, ränta, amortering).
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
6. **Google-provperioden går ut 2026-12-31.** Utan uppgradering pausar Google projektet och Street View-rutan
   slutar fungera (länkarna fungerar ändå). Embed API har varit gratis: be användaren uppgradera i god tid och
   lägga en budgetvarning (Set up budget alerts). Kontrollera Googles aktuella villkor och priser först.
7. När fastigheterna finns live: öppna några och klicka Street View (stadskärna, industriområde, stor tomt).
   Okänt hur rutan ser ut när bilden saknas nära mittpunkten; byt `mittpunkt` mot en punkt i polygonen om
   L-formade eller stora fastigheter hamnar fel.

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

- Python finns inte på datorn: ui-ux-pro-max:s sökskript går inte att köra (använd riktlinjerna direkt), och
  skript för att ändra filer skrivs i Node. Långa `node - <<'EOF'`-heredocs med citattecken i texten kan få
  Bash-verktyget att vägra ("unexpected EOF"); skriv då skriptet till scratchpad med Write och kör filen.
- Auto-läget stoppade `read_terminal` på deploy-fliken 2026-10-11 ("Production Deploy"): användaren läser av
  utskriften, Claude kontrollerar efteråt med `curl https://horos.se/api/status`.
- `/thermo-nuclear-code-quality-review` finns inte här; granskning görs med `/ponytail:ponytail-review` eller
  `/code-review`.
- Skärmbilder i webbläsarpanelen är nedskalade: klicka hellre via `find`/`read_page`-referenser än koordinater.

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
- Auto-läget stoppar `gh pr merge` och `deploy.sh` om användaren inte uttryckligen bett om just det i sitt senaste
  meddelande ("merga och publicera" fungerade). `git checkout`/`git pull` som egna kommandon, inte kedjade.
  Deploy startas med `run_in_terminal` i en ny flik; användaren skriver lösenfrasen där, Claude läser av fliken.
- Hetzners konsol: `sed -i 's,a,b,' fil` med `,` som avgränsare och `\x3a` för kolon fungerade utan Skift
  (2026-10-11). Konsolen nås via knappen `>_` uppe till höger på serversidan.
- Den lokala servern har ingen Google-nyckel: prova rutan genom att sätta `(await statusP).streetview = 'x'` i
  konsolen och öppna en fastighet (Google svarar "API key is invalid", det är väntat).

## Kända brister

- Scenarier: finns bara i webbläsaren där de skapades (flytta med länk eller fil); de korta länkarna ligger på
  servern utan säkerhetskopia och utan gallring. Vid sidladdning med ett öppet scenario hämtas dess underlag
  (upp till 1 000 fastigheter) en gång. Samma scenario öppet i två flikar: den som sparar sist vinner.

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
- Street View pekar på bboxens mitt och kameran har Googles standardriktning, inte mot byggnaden.
  Färga efter kan växa och då krocka med utfälld Street View även över 700 px fönsterhöjd.
