# Överlämning till Claude: detaljplaner, 2026-10-21

> **Inaktuell i delar (tillägg samma kväll).** Efter denna överlämning: NGP importerat för alla 264 kommuner
> (`import-ngp --kommun alla`, PR 54), plandokument hämtas vid första klicket i stället för i förväg (PR 57),
> äldre planer ur 62 kommuners öppna karttjänster (`import-kommunplaner`, PR 58–64), dygnsjobbet hämtar NGP varje
> natt och kommunplanerna varje vecka, och en kommun som misslyckas stoppar inte resten (PR 62). Uppgifter nedan om
> "bara Stockholm", om att dygnsjobbet hämtar alla PDF:er och "Vad som återstår" punkt 1–2, 4–5 gäller inte längre.
> Aktuellt läge: CLAUDE.md under "Detaljplaner" och PRIVAT.md under "Kommunerna: detaljplaner".

## Läget nu

**Publicering slutförd enligt användaren:** användaren har kört både deploy med data och root-installationen av dygnsjobbet. Efteråt verifierades live: `/api/status` HTTP 200, 20 planer i kart-API:t, 12 ytbestämmelser vid testpunkten i Vevstaken 29 och både plankarta och planbeskrivning med HTTP 200 samt `application/pdf`. `/api/status` har ännu `uppdaterad: null` och tomma `datakallor`; ingen lyckad automatisk körning har alltså rapporterats där ännu. Timerstatus kunde inte kontrolleras via icke-interaktiv SSH eftersom nyckeln kräver lösenfras. Installationsbeskedet kommer från användaren. Första dygnskörningen och eventuell SCB-konfiguration återstår att verifiera. Tidigare noteringar nedan om att uppladdning/installation återstår är historiska.

**Senaste status:** dagens klickbara planruta, bestämmelser, PDF-länkar, dagliga uppdatering och granskningsrättningar är mergade i PR #53: https://github.com/nimapima1/horos/pull/53, mergecommit `5dc4738a11eeabf8561c83671d170071b0189ae7`. Användaren har godkänt merge och publicering. Arbetskopian är uppdaterad till denna commit. Ny publik databas byggs med `--alla-bolag`, och de 40 PDF-filerna finns lokalt i `public/plandokument`. Uppladdning med `deploy ... --data` och engångsinstallationen som root av `deploy/installera-uppdatering.sh` återstår vid denna notering. Styckena nedan beskriver tidigare steg; deras formuleringar om att koden inte är mergad är historiska. Full testsvit: 121 passerade, ett överhoppat.

### Nytt lokalt: daglig uppdatering av fler datakällor

Efter ytterligare Ponytail Review rättades tre problem före publicering. Återställningen sätter nu läsrättigheter på den återställda databasen före omstart. NGP:s hämtningstider lagras per kommun i `lib/uppdateringsmeta.mjs`; en ny import för Stockholm skriver inte över andra kommuners tider eller planer vid deploy. SCB-importerna sparar separata hämtningstider i samma transaktion som data. `deploy --data` avbryts före databasbytet om serverns SCB-ägarkontroll eller arbetsställen är nyare än det lokala underlaget. Publicering utan SCB-villkor får inte bära med sig en falsk hämtningstid för arbetsställen. De tre regressionstesterna misslyckades före rättningarna och passerar nu. Senaste fulla testkörning: 121 passerade och ett överhoppat. Återställningens kommandoflöde testades med simulerade filrättigheter; installation och återställning på VPS:en återstår fortfarande. Inget av detta är mergat eller publicerat.

Användaren har bett om automatisk uppdatering av kartan, även utanför planerna, och valt **dagligen**. Stödet är implementerat och testat lokalt, men inte mergat, publicerat eller installerat på servern. Se `deploy/DEPLOY.md`, avsnittet Daglig datauppdatering, för installation och omfattning. Den tidigare punkten nedan om att ingen schemalagd import byggts är därmed historisk; något schema är fortfarande inte aktiverat live.

- `deploy/horos-uppdatering.timer` och `.service`: 06:15 Europe/Stockholm med upp till tio minuters spridning, tar igen missad körning. Root installerar med `deploy/installera-uppdatering.sh` efter publicering.
- `deploy/uppdatera.sh`: gemensamt lås med deploy och nyhetscron, arbetskopia, publikkontroller, hälsokontroll, återställning vid fel och komprimerat arkiv. Arkiv raderas inte; diskutrymmeskontroll stoppar jobbet innan disken blir full.
- `scripts/uppdatera-data.mjs`: NGP-planer/bestämmelser/dokument för tidigare importerade kommuner, nyheter och MFN. SCB:s ägarkontroll kräver nyckel; arbetsställen kräver dessutom publiceringsvillkor och riktiga fastigheter. Filbaserade källor och flygfoton anges ärligt som manuella, inte uppdaterade.
- Geotorget-inloggning läses från befintlig secrets.env av systemd. SCB-nyckeln är inte verifierad som installerad på servern.
- `scripts/behall-planer.mjs`: deploy behåller serverns nyare NGP-planer när en lokal databas laddas upp. Importen och build-public bevarar källans hämtningstid.
- PDF-filer får en beständig plats i `/var/lib/fastighetskarta/plandokument`. Nya kodversioner ska inte göra dokumentlänkarna ogiltiga.
- Kartan laddar om kartdata var femte minut i synlig flik och när fliken återaktiveras. Planrutor uppdateras när de öppnas igen.
- `/api/status` har `uppdaterad` och `datakallor`. Detta är senaste lyckade körning; fel rapporteras i systemd-journalen och gör inte gammal data färsk.
- Senaste fulla testkörning: 117 passerade, ett överhoppat. Schemat, systemd-installationen och riktiga SCB-anrop har inte körts på VPS:en.

### Senaste lokala arbete: klickbara planer och planbestämmelser

Dokumenttillägg: 40 PDF-filer har hämtats från NGP och importerats lokalt, två per plan, totalt cirka 248 MB. Lyckat svar finns i `data/raw/ngp-0180-dokument-1792577582294.json`. NGP:s `/asset/` skickar 303 till en skyddad `/data/detaljplan/`-adress, inte till kommunens publika adress. Importen hämtar därför PDF med autentisering enbart mot Lantmäteriet och sparar innehållshashade filer i `public/plandokument/`, som är gitignorerad. `plan.dokument` lagrar lokala länkar. Filerna följer med när deploy packar `public/`. PDF-filerna är kontrollerade för filsignatur och begränsas till 50 MB per dokument. `--dokument --dry` sparar filer och svar lokalt men skriver inte databasen. Riktig import gjordes sedan offline med `--fil`. Plankarta och planbeskrivning har verifierats som länkar i planrutan för Vevstaken 29. Funktionen är ännu inte mergad eller publicerad.

Uppdatering efter riktig hämtning: NGP-svaret finns lokalt i `data/raw/ngp-0180-1792576873879.json`. Det innehåller 20 planer och 996 bestämmelser, varav 982 ytor, 9 linjer och 5 punkter. Importen stannade först på en LineString. Den är nu rättad och en provkörning samt riktig import från den sparade filen har genomförts utan ytterligare lösenordsinmatning. Alla 996 bestämmelser finns i arbetsdatabasen. Linje- och punktbestämmelser visas separat i rutan med uttrycklig förklaring om att de inte gäller hela planområdet. Testsviten har nu 111 passerade tester och ett överhoppat. Publik databas och publicering av denna funktion återstår.

Efter PR #52 bad användaren om klickbara planer och att visa vad man får bygga direkt i rutan. Detta arbete är ännu inte mergat eller publicerat:

- `plan-fill` i `public/app.js` gör hela planområdet klickbart. En ruta visar namn, beteckning, status och laga kraft-datum, även utan fastighetsdata. Överlappande planer visas tillsammans. Klickfunktionen är provad i lokal webbläsare med Vevstaken 29.
- `planInfo` i `public/panel.js` visar även planbestämmelser vid klickpunkten. Pågående planer märks som förslag. Värden och enheter visas tillsammans med källans bestämmelsetext. Rutan gör inget eget besked om bygglov.
- Importen hämtar nu alla referensobjekt per kommun, inklusive planbestämmelser, och kopplar dem till planytorna med `detaljplan.objektidentitet`. Bestämmelsernas geometrier, texter och värden sparas i den nya JSON-kolumnen `plan.bestammelser`.
- `GET /api/planbestammelser/:id?punkt=lon,lat` väljer bestämmelser vid klickpunkten. Geometrier skickas inte till klienten. Äldre databaser utan kolumnen ger besked om saknade uppgifter.
- 110 tester passerar och ett hoppas över. Import/lagring, geografiskt urval och rendering är testade med testdata. **Riktig ny import av bestämmelser återstår**; de tidigare 20 planerna innehåller inte dessa uppgifter. Be användaren köra `scripts/import-ngp.mjs` med `--dry` först, därefter utan flaggan. Lösenordet skriver användaren själv i terminalen.
- Dokumentlänkar är fortfarande inte implementerade. Den tidigare publika databasen måste byggas om efter den nya importen för att bestämmelserna ska följa med till servern.

### Tillägg efter kodgranskning, samma dag

Ponytail Review hittade att fastighetskopplingen kunde missa små planer mellan rutnätets provpunkter, samt att POST-sidbläddringen saknade test. Båda är rättade och mergade i PR #52, https://github.com/nimapima1/horos/pull/52, mergecommit `98d078c7d5fa87aeff35519bdbc9f4e9daddfb26`. Användaren godkände publiceringen och meddelade att deploy utan `--data` var klar. Därefter kontrollerades livesidan: `/api/status` gav HTTP 200 och plan-API:t gav fortfarande 19 planer med laga kraft och en i samråd. Exakt serverversion kontrollerades inte via SSH; polygonrättningen är verifierad med lokala tester.

- `lib/geo.mjs`: `geomOverlap` kontrollerar polygonernas gemensamma yta, inklusive hål och MultiPolygon. Enbart kant- eller punktkontakt räknas inte.
- `server.mjs`: `planerPa` använder `geomOverlap` i stället för rutnätets provpunkter.
- Regressionstestet i `test/server.test.mjs` misslyckades före rättningen eftersom en liten innesluten plan saknades. Det passerar efter rättningen.
- `test/ngp.test.mjs` täcker nu tre POST-sidor med både sammanfogning och ersättning av sökkroppen. Ingen ändring av hämtkoden behövdes för detta fynd.
- Hela testsviten efter rättningarna: 106 passerade, ett hoppades över. Beskrivningen av den första publiceringen nedan avser PR #51; PR #52 har därefter publicerats enligt användarens besked.

NGP-integrationen är mergad och publicerad på https://horos.se. Stockholms kommun, kod 0180, är importerad: 20 planer, varav 19 med laga kraft och en i samråd. Både gällande och pågående planer visas. Användaren har godkänt och genomfört publiceringen.

- PR: https://github.com/nimapima1/horos/pull/51
- Mergecommit: `211b5ffc45b0cb8fb84540fc9b138f12c34c9cb5`.
- Arbetsgrenen vid överlämningen är `codex/ngp-planer`, uppdaterad till mergecommitten.
- En tidigare, separat metodändring på `metod-bolagsaffarer` ingår inte i PR #51. Den grenen innehåller också den ursprungliga NGP-committen. Undvik att merga in NGP dubbelt därifrån.

## Vad vi gjorde

Vi kontrollerade Lantmäteriets villkor. NGP-data tillhandahålls avgiftsfritt med öppen licens och får bearbetas och spridas även kommersiellt. Användaren ansökte själv via sitt befintliga Geotorget-konto och fick konsumentbehörighet. En riktig anslutningskontroll gav tillgång till 264 samlingar. Detta är inte ett antal planer eller ett bevis på fullständig kommuntäckning.

Vi byggde och verifierade import från NGP:s officiella API. Första försöken gav 404 respektive 400. Den fungerande kombinationen är:

- Basadress: `https://api.lantmateriet.se/distribution/geodatakatalog/sokning/v1/detaljplan/v2/`.
- `POST /search`, med kommunkod i `collections` och `query: { "feature.typ": { "eq": "detaljplan" } }` i JSON-kroppen.
- `crs=http://www.opengis.net/def/crs/OGC/1.3/CRS84` i URL:en. V1 använder annars SWEREF 99 TM som standard, medan Horos lagrar WGS84.
- Basic auth med Geotorget-uppgifter. Lösenordet skrivs dolt av användaren i terminalen, sparas inte och ska aldrig klistras in i chatten.

Vi började med att visa enbart laga kraft. På användarens begäran ändrade vi sedan till att även visa pågående planer med tydlig status.

## Kod och beteende

- `lib/ngp.mjs`: hämtning, sidbläddring, polygonvalidering och lagring. Sidlänkar begränsas till samma API-sökväg så att inloggningsuppgifter inte skickas till andra tjänster. GET/POST och body/merge stöds för nästa sida. Repetitiva sidor avbryter importen.
- `scripts/import-ngp.mjs`: import per fyrsiffrig kommunkod, med `--dry`. Alla sidor hämtas och alla geometrier valideras innan databasen skrivs.
- `scripts/testa-ngp.mjs`: anslutningskontroll som räknar samlingar utan att skriva data.
- `package.json`: nytt kommando `import:ngp`.
- `lib/db.mjs`: tabellen `plan` har fått `kalla` och `status`, inklusive migrering av äldre arbetsdatabaser. Befintliga planer får källan `lantmateriet`. NGP får `kalla='ngp'` och id `ngp:<kommunkod>:<objektidentitet>`.
- En ny fullständig kommunhämtning markerar tidigare NGP-poster för kommunen som `arkiverad` och uppdaterar/återaktiverar dem som finns i svaret, inom en transaktion. Inga planposter raderas permanent.
- `server.mjs`: plan-API:t och fastighetspanelens underlag skickar källa och status. Äldre publika databaser utan de nya kolumnerna stöds.
- `public/panel.js`: tabellen Detaljplan har statuskolumn. Pågående planer har texten "Har inte fått laga kraft". Källtexten anger att äldre planer kan saknas.
- `public/metod.html`: NGP beskrivs som en separat källa med öppen licens.
- `scripts/build-public.mjs`: NGP-planer tas med utan `--lm-planer`. Andra planuppgifter kräver fortfarande det flaggade licensbeslutet. Blanda inte ihop dessa källors villkor.

Statusar som visas och följer med i den publika databasen är `påbörjad`, `samråd`, `granskning`, `antagen`, `överklagad`, `tillsyn` och `laga kraft`. `upphävd`, `avslutad`, `arkiverad` och okända statusar visas inte. De behålls i arbetsdatabasen.

## Verifierat

- `npm test`: 104 tester passerade, ett test hoppades över. Serverkontrollerna behöver lokal nätverksåtkomst; sandboxen gav annars EACCES.
- Testerna täcker bland annat sidbläddring, autentisering, stopp för främmande sidlänkar, geometri, uppdatering/arkivering, publikt urval och planstatus i kart-API/fastighetspanel.
- Användaren körde först `--dry` och därefter riktig import för 0180. Resultatet var 20 planer.
- Publik databas byggdes med `node scripts/build-public.mjs --alla-bolag`. Tidigare fil finns kvar som `data/public_NGP_FORE_20261021_GAMMAL.sqlite`. Den filen är lokal och inte i git.
- SQLite `PRAGMA quick_check` gav `ok` på publiceringsfilen.
- Användaren körde `deploy/deploy.sh deploy@37.27.152.172 --data` från sin PowerShell och skrev SSH-lösenfrasen själv. Körningen avslutades med lokalt HTTP 200.
- Efter publiceringen kontrollerade vi https://horos.se/api/planer?bbox=17,58,20,61: 19 med laga kraft och en i samråd. Publicerade `panel.js` innehöll den nya statusmärkningen.

Den publika databasen har fortfarande **0 fastigheter**. Planerna finns i planlagret, men kopplingen till riktiga fastighetspaneler kan inte bedömas visuellt med verkliga fastigheter förrän fastighetsdata finns. API-kopplingen har testats med testdata.

## Varför bara 20 planer?

Vi importerade endast Stockholms kommun, inte hela landet. NGP är dessutom inte ett fullständigt historiskt planregister. Enligt Lantmäteriet behöver planer påbörjade före 2022-01-01 inte tillgängliggöras digitalt och kan saknas.

Importen har sidstorlek 100, ingen gräns på 20, och följer nästa-sida-länkar. Vi har inte gjort en separat autentiserad kontroll av API:ts totala träffantal. Det finns ingen verifierad uppgift här om Stockholms totala bestånd av detaljplaner.

Källor:

- https://www.lantmateriet.se/sv/nationella-geodataplattformen/datamangder/detaljplan/
- https://www.lantmateriet.se/globalassets/temawebbar/ngp/anvandningsvillkor-geodataplattformen.pdf
- https://namespace.lantmateriet.se/distribution/geodatakatalog/sokning/v1/detaljplan/v2/detaljplan-api-2.2.yaml

## Vad som återstår

1. **Täckning för äldre planer.** Utred komplettering från kommunernas öppna geodata eller Lantmäteriets Markreglerande bestämmelse. Befintliga `scripts/import-planer.mjs` läser GeoPackage från den senare produkten. Kontrollera tillstånd och villkor före import/publicering. Ingen skrapning eller bulkhämtning via e-tjänster.
2. **Fler kommuner.** Importen är generell men har bara körts för 0180. Inventera NGP:s samlingar och planera fler kommuner utan att anta att alla har samma täckning.
3. **Tydligare status på själva kartan.** Status skiljs nu åt i fastighetspanelens tabell och finns i API:t. `public/app.js` använder fortfarande samma linjefärg och streckning för alla planer. Ingen statuslegend, statusfiltrering eller separat planpopup byggdes. Detta är en möjlig fortsättning, inte redan levererad funktion.
4. **Plandokument.** Vi hämtar referensobjekt, inte hela domänobjekten eller dokumenten. API:ts dokument-/resurslänkar sparas inte ännu. Utred säker länkning till kommunens plankarta och planbeskrivning. Befintliga planenheter från andra källor saknar också färdig dokumentkoppling.
5. **Uppdateringar.** NGP hämtas manuellt per kommun. Ingen schemalagd import, OAuth-klient eller ny hemlighet på servern har installerats för NGP. Serverns befintliga nyhetscron sköter inte planerna.
6. **Visuell kontroll.** Kontrollera statuskolumnens läsbarhet på mobil och de rumsliga kopplingarna när riktiga fastigheter finns. De automatiska testerna ersätter inte detta.

## Köra importen igen

Från projektmappen i användarens terminal, med användarens Geotorget-användarnamn:

```powershell
node scripts/import-ngp.mjs --kommun 0180 --user <användarnamn> --dry
node scripts/import-ngp.mjs --kommun 0180 --user <användarnamn>
```

Lösenordet efterfrågas separat för varje körning. Användaren skriver det själv. OAuth rekommenderas i Lantmäteriets dokumentation men är inte implementerat här.

Fortsatt publicering kräver användarens godkännande enligt projektreglerna. Godkännandet i denna chatt gällde den genomförda publiceringen av PR #51 och de 20 planerna.
