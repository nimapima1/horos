# Överlämning 2026-10-13 (kväll)

Läs `CLAUDE.md` först (regler, teknik, server) och `PRIVAT.md` (inte i git: mejlkontakter, myndighetsärenden,
kostnader). Den här filen beskriver läget efter sessionerna 2026-10-10 till 2026-10-13 och vad som ska göras härnäst.
Detaljer om SCB:s arbetsställen (API, fält, koder, villkor) står i `OVERLAMNING-hyresgaster.md`.

## Läget

- **Publikt repo**: https://github.com/nimapima1/horos (AGPL-3.0-or-later). Allt är committat, pushat och mergat
  (`master` = `origin/master` = koden på horos.se). Sådant som inte ska vara publikt (namngivna personers adresser, förhandlingsläge,
  kostnader, nycklar) läggs i `PRIVAT.md`. Äldre commits innehåller fortfarande mejlutkast och mottagaradresser
  (015a319, 8fa017e); historiken skrivs **inte** om (beslut 2026-10-10: redaktionernas publika adresser, redan pushat).
- **Live**: https://horos.se och https://www.horos.se (skickas vidare), HTTPS med Let's Encrypt.
  - Koden till och med PR #25 (50492f1, 2026-10-13 kväll), deployad och kontrollerad med curl. Däri från 2026-10-13:
    PR #22 och #24 (skydd mot massnedladdning och trafiktak, se nedan), #23 (pressmeddelanden: bolagets samlade
    fastighetsvärde är inget affärspris), #21 (rättningar efter Codex granskning, 17 fynd) och #20 (AGENTS.md, kopia
    av CLAUDE.md för Codex; uppdatera båda). Tidigare: PR #17 (inläsning från Excel/CSV och omstruktureringen). PR #16 (scenarier som
    räknas ihop, Med/Huvud, scenarier på kartan), PR #12–#15 (MFN-mottagaren, se nedan), PR #11 (decimalkomma,
    Street View och scenariovyn på mobil), PR #8 (scenarier och ny panel) och PR #2–#7 från 2026-10-11.
  - Publik databas byggd 2026-10-11 17:52 (enligt `/api/status`) med `--alla-bolag`, publicerad med `--data`: 0 fastigheter,
    2,2 miljoner bolag (ägarkontrollen som ord: `stat`, `kommun`, `region` …), 120 177 adresser, inga
    arbetsställen (byggt utan `--scb-villkor`), 127 affärer ur pressmeddelanden (uppdateras av cron).
  - Servern: cloud-init v3 + ändringarna i v4–v5 inlagda för hand (www-blocket, inget `Via`-huvud,
    `set-secret` utan längdutskrift), plus `frame-src https://www.google.com` i CSP:n (2026-10-11, i
    `/etc/caddy/Caddyfile.template` och `set-domain horos.se`). Root-lösenordet återställdes 2026-10-10
    (Hetzner > Rescue); användaren har det. Drop-in `fastighetskarta.service.d/scenarion.conf` (cloud-init v6,
    `StateDirectory=horos-scenarion`) inlagd 2026-10-11: korta länkar till scenarier är på. Trafiktaket
    (`horos-trafiktak.service`, 50 Mbit/s ut) installerat som root 2026-10-13.
  - `secrets.env`: GEOTORGET_USER/PASS, GOOGLE_EMBED_KEY och MFN_SECRET (2026-10-12).
- Grenar: bara `master`, lokalt och på GitHub (alla mergade grenar togs bort 2026-10-13).
- `npm test`: 87 gröna. Prova lokalt: `preview_start {name: "horos-3005"}` (autoPort; port 3005 kan vara upptagen
  av en annan session). Starta om servern efter import eller demo-data.
- Publicera: `& "C:\Program Files\Git\bin\bash.exe" deploy/deploy.sh deploy@37.27.152.172 [--data]` i användarens
  terminal (lösenfras **direkt**, annars stänger servern anslutningen; det hände två gånger 2026-10-10). Första
  försöket 2026-10-12 hann inte (lösenfrasen skrevs för sent); andra gick igenom. Ett avbrutet försök lämnar en flik
  som väntar på lösenfrasen och som Claude inte får stänga om användaren skrivit i den. Deploy
  laddar upp arbetskatalogen som den är: kontrollera `git status` först så att ingen annan sessions ocommittade
  ändringar följer med.

## Gjort 2026-10-13: driftkostnader och skydd mot massnedladdning (PR #22, #24, #25)

Användaren frågade vad Horos kostar och om massnedladdning kan ge en faktura. Kostnaderna står i `PRIVAT.md`
(Driftkostnader). Det som kan växa med trafiken är bara Hetzners trafik över 20 TB/månad (~1 €/TB) och en
Google-nyckel som går att använda mot betalda API:er. Båda är stängda:
- **Trafiktak** (PR #24, `deploy/trafiktak.sh`): `tc` (htb + fq_codel) begränsar all utgående trafik till 50 Mbit/s,
  högst 16,7 TB på 31 dygn. Under en attack blir sajten långsam i stället för dyr. Installerat som root i Hetzners
  konsol med `bash /opt/fastighetskarta/current/deploy/trafiktak.sh installera` (systemd-tjänst, sätts vid varje
  uppstart); utskriften visade `rate 50Mbit ceil 50Mbit`. Ta bort: kommandona överst i skriptet.
- **Diskcachen för historiska flygfoton** (PR #22) växte utan gräns (Stockholm × 13 årgångar ≈ 150–200 GB, disken
  är 40 GB): `diskRymmer()` i `server.mjs` slutar spara rutor när mindre än `CACHE_MIN_LEDIGT_GB` (10) är ledigt.
- **Hastighetsgränser** (PR #22), nya hinkar i `RATE`: `historisk` 300/10 s (Lantmäteriets tjänst) och `export`
  2/10 s för hela databasen som fil. Provat live: tredje nedladdningen inom 10 s fick 429.
- **Google** (användaren i konsolen): nyckeln begränsad till bara Maps Embed API (utöver horos.se), budgetlarm
  "Horos" 10 kr/månad (50/90/100 %, mejl).
- Codex granskade PR #22 utan fynd i ändringen (se Tips om hur Codex beter sig här).

## Gjort 2026-10-12 (eftermiddag och kväll): lägga ihop scenarier och läsa in från fil (PR #16–#17)

- **Scenarier som räknas** (tabellen överst i scenariovyn, `ihoplagda` i `scenario.js`): varje annat scenario i Mina
  scenarion har kryssrutan **Med** (läggs ihop med det öppna) och radioknappen **Huvud**. Huvudscenariot bestämmer
  startår och kalkylperiod och dess antaganden gäller först när en fastighet finns i flera; väljs ett annat öppnas det
  och gruppen följer med dit (dess egna ihoplagda behålls, `gorHuvud`). Data: `delar` = kopior av andra scenarier
  (fastigheter och antaganden, `nyckel` till Mina scenarion; uppdateras därifrån när scenariot öppnas, så en delad
  länk har allt). `beraknaPortfolj` i `kalkyl.js` summerar, varje fastighet en gång. Tabellen visar fastigheter, yta,
  taxeringsvärde och värde per scenario och summan; nyckeltal och kassaflöde gäller summan. På mobil som kort.
  Vägen dit (för den som undrar varför): först Addera/Subtrahera-knappar, sedan +/− i Mina scenarion, sedan
  Av/Lägg till/Dra ifrån; användaren tyckte att riktningen var otydlig och "Dra ifrån" överflödigt.
- **Kartan**: det öppna scenariot och de ihoplagda i tabellens färger (`ritaScenarier`: gränser från zoom 14 via
  lagret `scenario-line`, prickar under via `scenario-punkt`), vitt där en fastighet finns i flera; teckenförklaringen
  listar dem. Inte blått (`--c1`), som kartans egna kluster har.
- **Läs in från fil** (Scenarier > Läs in från fil, `public/inlasning.js`): Excel (.xlsx, zip uppackad med webbläsarens
  `DecompressionStream`, XML med `DOMParser`, första bladet enligt arbetsboken) eller CSV blir ett nytt scenario med
  filens namn. Filen laddas inte upp; raderna (beteckning, adress, kommun) matchas med `POST /api/matcha`
  (`matchaRad` i `server.mjs`). **Kommunen krävs** (samma beteckning finns i flera kommuner, användarens beslut):
  från kolumnen, först i beteckningen ("Stockholm Kungsbron 1") eller efter komma i adressen; `kommunAv`/`kommunForst`
  i `lib/kommuner.mjs` känner igen alla 290 kommuner. Beteckningen prövas med och utan kommunnamn (Lantmäteriets
  format okänt); annars adressen (exakt gata och nummer, alla träffar i adressökningen) och fastigheten där den ligger.
  Rapporten överst: hittade, via adress, rader utan känd kommun (t.ex. postorten Bromma) och rader som inte hittades.
  Mall att ladda ner.
- **Omstrukturering** (thermo-nuclear-granskningen): `server.mjs` hölls under 1 000 rader genom att lagringen av korta
  länkar flyttades till `lib/scenarier.mjs` och kommunnamnen till `lib/kommuner.mjs`.
- **Granskningar**: ponytail-review på båda PR:erna (4 + 3 fynd, alla åtgärdade) och thermo-nuclear på #17 (3 fynd).
- Provat i webbläsarpanelen med exempeldata (634 fastigheter) och en riktig .xlsx skapad med Python; inte med filer
  från Numbers eller Google Sheets.

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
  - **MFN svarade 2026-10-12**: de kan erbjuda pressmeddelanden för bolag som använder MFN som
    distributionstjänst (inte alla bolag på mfn.se). Användaren svarade ja samma dag och frågade om leveranssätt
    och hämtfrekvens, villkor/kostnad och källangivelse. MFN svarade direkt: de **skickar** (push) och vill veta
    leveranssätt (HTTP(S)/SFTP), format (JSON/XML) och URL. Dokumentation: https://modfin.gitbook.io/mfn
    (WebSub, News Item). Beslut: bygga mottagaren först, sedan svara HTTPS, JSON och `https://horos.se/api/mfn`.
  - **Mottagaren är live sedan 2026-10-12** (PR #13, deployad 09:09): `POST /api/mfn` kontrollerar `X-Hub-Signature` (HMAC-SHA256, `MFN_SECRET`),
    `tolkaMfn` behåller bara svenska köp/försäljningar, och de sparas utan text i `mfn.sqlite` i appens
    StateDirectory. Cron (`deploy/nyheter.sh`) kör `import-nyheter --mfn` efter Cision och startar om om något
    ändrats; MFN-pressmeddelanden syns alltså inom ett halvt dygn. Ingen root-ändring behövs.
  - `MFN_SECRET` är satt (2026-10-12) och kontrollerad: `https://horos.se/api/mfn?hub.challenge=x` svarar `x`,
    fel signatur ger 403. Användaren har hemligheten (aldrig i chatten). Byta: generera och lägg in utan att den
    visas, i PowerShell:
    `$s = node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"; Set-Clipboard $s; $s | ssh deploy@37.27.152.172 "sudo -n /usr/local/sbin/fastighetskarta-admin set-secret MFN_SECRET"`.
  - **MFN:s svar 2026-10-12** (hemligheten skickad samma dag): de lägger upp prenumerationen (förnyas inte),
    skickar **alla** bolags pressmeddelanden (filtrera själva), ingen kostnad, källa "MFN", leveransen börjar
    direkt med riktiga pressmeddelanden. De frågade om gränser (tecken, storlek, bilder, video, formatering,
    tabeller); användaren svarade 13:41 (vi visar bara rubrik, datum och länk). Mottagaren tog högst 1 MB; MFN svarade 2026-10-15 att pressmeddelanden kan vara större och att flödet är uppsatt, så gränsen är 10 MB (egen hastighetsgräns, `RATE_MFN`) och avvisade anrop loggas (`MFN avvisad: …`).
  - **Filtret** (PR efter #14): mottagaren sparar alla svenska affärer med utgivarens org.nr; cron tar bara med
    fastighetsbolagens (`arFastighetsbolag`: SNI 68, namn med fastighet/bostad/property/real estate, eller
    `MFN_FASTIGHETSBOLAG` för moderbolag med SNI 70100/64xxx: Castellum, Sagax, SBB, Pandox, K-Fast, Eastnine,
    Heimstaden, Titania). Saknas ett fastighetsbolags affär: lägg till dess org.nr i listan. Rader från före
    filtret (utan org.nr) tas inte med. Journalen har en rad per mottaget pressmeddelande:
    `ssh deploy@37.27.152.172 sudo -n /usr/local/sbin/fastighetskarta-admin logs 200` (sök på `MFN`).
  - **Ta bort ett felaktigt MFN-pressmeddelande** (fel fastighet, fel pris): lägg dess url i undantagsfilen, så
    tas det bort vid nästa cron-körning och kommer inte tillbaka:
    `ssh deploy@37.27.152.172 "echo 'https://mfn.se/...' >> /var/lib/fastighetskarta/mfn-undantag.txt"`.
    `mfn.sqlite` ägs av appen och kan inte ändras av deploy.
  - Ja från en tidning: bara rubrik + länk + det vi själva läser ut; ingen artikeltext, inget bakom betalvägg.
  - Fastighetsnytt fick också frågan om vem som svarar för DI (samma koncern, Bonnier News).
- Skatteverket, Lantmäteriet (lagfarter, geodatasupport) och Geotorget-ärendena: se `CLAUDE.md` och `PRIVAT.md`.
  Be användaren kontrollera att ansökan om **Byggnad** verkligen skickades (stod som "ifylld 2026-10-09").

## Förslag till nästa session

0. **Scenarier**: korta länkar är provade live 2026-10-12: ett tomt scenario (Filter > Räkna på träffarna, 0 fastigheter)
   sparades på horos.se som `#s=LSXqzbXIW5` och gick att hämta via `/api/scenario/LSXqzbXIW5`. Den långa `#sd=`-länken
   får man bara när servern inte svarar (t.ex. en stoppad lokal testserver i webbläsarpanelen). Kvar att prova: läsa in en
   Excelfil från Numbers eller Google Sheets. Decimalkomma är rättat
   2026-10-12 men inte provat på riktig iPhone. När taxeringen kommer: ta ytor (LOA/BOA) och
   bostads-/lokalvärde därifrån i stället för uppskattningen och skatteschablonen. Möjliga nästa steg: öppna
   standardvärden (t.ex. SCB:s bostadshyror per kommun) och finansiering (lån, ränta, amortering).
1. Kolla Gmail efter svar på tillståndsmejlen (MFN: svar på följdfrågorna; Fastighetsvärlden och Fastighetsnytt
   har inte svarat, kollat 2026-10-12).
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
   slutar fungera (länkarna fungerar ändå). Embed API har varit gratis: be användaren uppgradera i god tid.
   Budgetlarmet (10 kr/månad) och begränsningen till Maps Embed API är gjorda 2026-10-13. Kontrollera Googles
   aktuella villkor och priser först.
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

- Lokala testservrar i webbläsarpanelen (`preview_start {name: "horos-3005"}`) får ny port när 3005 är upptagen, och en
  flik kan ligga kvar mot en stoppad server: då misslyckas sparning och anrop (`#sd=`-länk i stället för `#s=`). Starta om
  servern efter ändringar i `server.mjs` (en gammal server svarar 405 på nya POST-rutter).
- `thermo-nuclear-code-quality-review` finns i `~/.claude/skills/` men laddades inte i sessionen 2026-10-12; läs
  `SKILL.md` och följ den för hand om den inte syns i listan.

- Python 3.13 finns men inte i PATH: `/c/Users/nimab/AppData/Local/Programs/Python/Python313/python.exe` (med
  `PYTHONIOENCODING=utf-8`), t.ex. för ui-ux-pro-max:s sökskript. Skript som ändrar filer skrivs ändå i Node. Långa
  `node - <<'EOF'`-heredocs med citattecken i texten kan få
  Bash-verktyget att vägra ("unexpected EOF"); skriv då skriptet till scratchpad med Write och kör filen.
- Auto-läget stoppade `read_terminal` på deploy-fliken 2026-10-11 ("Production Deploy"): användaren läser av
  utskriften, Claude kontrollerar efteråt med `curl https://horos.se/api/status`.
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
- Codex (`codex:codex-rescue`, 2026-10-13): kommandoverktyget föll första gången ("setup refresh had errors");
  andra gången körde det men testerna föll på skrivskydd i Codex sandlåda (EPERM), så räkna inte dess testsiffror.
  Det läste också grenen mot en gammal `origin/master` och rapporterade ett fel som redan var rättat på master.
- `read_terminal` på deploy-fliken fungerade 2026-10-13 efter att användaren skrivit lösenfrasen.
- Den lokala servern har ingen Google-nyckel: prova rutan genom att sätta `(await statusP).streetview = 'x'` i
  konsolen och öppna en fastighet (Google svarar "API key is invalid", det är väntat).

## Kända brister

- Scenarier: finns bara i webbläsaren där de skapades (flytta med länk eller fil); de korta länkarna ligger på
  servern utan säkerhetskopia och utan gallring. Vid sidladdning med ett öppet scenario hämtas dess underlag
  (upp till 1 000 fastigheter) en gång. Samma scenario öppet i två flikar: den som sparar sist vinner.
  Ihoplagda scenarier: väljs ett annat huvudscenario flyttar gruppen dit (två olika grupper kräver två huvudscenarier);
  färgerna på kartan följer ordningen i tabellen och kan byta när man bockar ur.
- Inläsning från fil: bara första bladet; inte gamla .xls eller zip64; adresserna är OSM tills Lantmäteriets
  belägenhetsadresser finns. Hur Lantmäteriets beteckningar ser ut (med eller utan kommunnamn) är okänt; båda prövas.

- Pressmeddelandena tolkas med regler (regexar): fastigheter kan saknas eller bli fel, och priset är bolagets
  uppgift (ofta underliggande fastighetsvärde). Felaktiga kandidatbeteckningar syns aldrig, eftersom bara
  beteckningar som finns bland de tillåtna fastigheterna publiceras.
- Publikt (cron) hoppas adresser som finns på flera ställen över, så servern visar ibland färre platser än en
  lokal import. Ett pressmeddelande som tagits bort lokalt kan komma tillbaka vid `--data` om det redan fallit ur
  Cisions flöde (ovanligt).
- Om cron-jobbet misslyckas syns det bara i `nyheter.log`; ingen avisering.
- Hastighetsgränserna är per IP och i minnet: många adresser tar sig förbi dem (trafiktaket begränsar ändå
  kostnaden). Trafiktaket är inte provat under full last, och spärren för full disk är inte provad. Taket försvinner
  om nätverket startas om utan omstart av servern (då: `systemctl restart horos-trafiktak`).
- `/api/kommunkluster` räknar över alla fastigheter vid första anropet med ett nytt filter; inte mätt med
  rikstäckande data (förberäkna i build-public om det blir långsamt).
- Uppskattad LOA kan bli orimlig (stora arbetsgivare, lokaler utan företag); tumreglerna står på metodsidan.
- Filtren räknar per fastighet i kartutsnittet vid varje anrop; län och kommun är bara provade med Stockholm.
- Street View pekar på bboxens mitt och kameran har Googles standardriktning, inte mot byggnaden.
  Färga efter kan växa och då krocka med utfälld Street View även över 700 px fönsterhöjd.
