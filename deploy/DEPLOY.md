# Publicera Horos på Hetzner

Engångsuppsättning tar ungefär 20 minuter. Därefter räcker ett kommando för varje uppdatering.

Servern heter `horos-3` i Hetzner (Helsingfors, 37.27.152.172). Internt på servern heter tjänst, kataloger och
admin-skript `fastighetskarta`, t.ex. `/opt/fastighetskarta` och `fastighetskarta-admin`.

Serverkonfiguration: [`cloud-init.yaml`](cloud-init.yaml) version 5. Caddy installeras från
Caddys GitHub-releaser (SHA-512 kontrolleras) och uppdateras veckovis av en timer, eftersom
Caddys apt-förråd hos Cloudsmith svarar 402. Node uppdateras via unattended-upgrades, och
servern startar om 04:30 när en uppdatering kräver det. Version 1 (157.180.82.3) och
version 2 (77.42.15.67) fick Ubuntus gamla Caddy 2.6.2.

Underhåll utan att bygga om servern:

```sh
ssh deploy@<IP> sudo -n /usr/local/sbin/fastighetskarta-admin update-caddy
ssh deploy@<IP> sudo -n /usr/local/sbin/fastighetskarta-admin upgrade-system
ssh deploy@<IP> sudo -n /usr/local/sbin/fastighetskarta-admin reboot
```

> **Innan något med Lantmäteriets data publiceras:** ansökan om *Fastighetsindelning* måste
> vara beviljad, och beslutets villkor lästa. `build:public` vägrar ta med Lantmäteriets data
> utan `--lm-beslut <ärendenummer>`, och servern vägrar starta om databasen innehåller
> exempeldata eller fastigheter utan juridisk ägare. Det motsvarar åtagandet i ansökan.

## 1. SSH-nyckel (en gång)

I Git Bash eller PowerShell:

```sh
ssh-keygen -t ed25519 -C "fastighetskarta"
```

Tryck Enter för standardplatsen och välj en lösenfras. Den publika nyckeln hamnar i
`C:\Users\<du>\.ssh\id_ed25519.pub`. Det är den filen (och aldrig den utan `.pub`) som
klistras in hos Hetzner.

## 2. Skapa servern i Hetzner Cloud Console

1. Skapa ett konto på [hetzner.com/cloud](https://www.hetzner.com/cloud) och ett projekt.
2. **Add Server**:
   - **Location:** Helsinki (det som står i ansökan till Lantmäteriet)
   - **Image:** Ubuntu 24.04
   - **Type:** den minsta delade x86-typen (2 vCPU, 4 GB RAM räcker gott)
   - **Networking:** Public IPv4 + IPv6
   - **SSH keys:** lägg till innehållet i `id_ed25519.pub`
   - **Cloud config:** klistra in hela [`cloud-init.yaml`](cloud-init.yaml)
   - **Backups:** rekommenderas (kostar ca 20 % extra)
3. Skapa servern och notera IP-adressen. Installationen fortsätter i bakgrunden i några
   minuter efter att servern syns som igång.

Kontrollera att allt är klart:

```sh
ssh deploy@<IP> "cloud-init status --wait && node --version && caddy version"
```

## 3. Första publiceringen

```sh
npm run build:public                  # bygger data/public.sqlite
deploy/deploy.sh deploy@<IP> --data   # laddar upp kod + databas
```

Sidan finns nu på `http://<IP>` (utan HTTPS tills en domän är satt).

## 4. Domän och HTTPS

1. Köp en domän (t.ex. en .se-domän) och peka en **A-post** (och gärna **AAAA**) mot
   serverns IPv4/IPv6, både för domänen och för **www**. Servern skickar www vidare till domänen och
   behöver ett certifikat även för www; saknas www-posten försöker Caddy om och om igen.
2. När DNS slagit igenom:
   ```sh
   ssh deploy@<IP> sudo /usr/local/sbin/fastighetskarta-admin set-domain fastighetskarta.se
   ```
   Caddy hämtar och förnyar certifikat från Let's Encrypt automatiskt.

## Uppdateringar

```sh
deploy/deploy.sh deploy@<IP>          # bara ny kod
npm run build:public && deploy/deploy.sh deploy@<IP> --data   # ny data
```

Pressmeddelanden som servern hämtat (cron, `deploy/nyheter.sh`) följer med vid `--data`.

Med Lantmäteriets data när ansökan beviljats:

```sh
node scripts/build-public.mjs --lm-beslut <ärendenummer>
deploy/deploy.sh deploy@<IP> --data
```

## Sparade scenarier (korta länkar)

Besökarnas sparade scenarier ligger i `/var/lib/horos-scenarion/scenarion.sqlite`, utanför
den publika databasen, så de följer inte med vid `--data` och skrivs inte över. Katalogen
skapas av systemd (`StateDirectory=horos-scenarion`, cloud-init v6). På en server från v5 eller
äldre läggs inställningen in en gång som root i Hetzners webbkonsol, efter en publicering
(kommandona har inga tecken som kräver Skift):

```sh
install -D -m 644 /opt/fastighetskarta/current/deploy/scenarion.conf /etc/systemd/system/fastighetskarta.service.d/scenarion.conf
systemctl daemon-reload
systemctl restart fastighetskarta
```

Utan den fungerar scenarierna ändå, men länken innehåller då hela scenariot (`#sd=…`) i stället
för ett kort id (`#s=…`); `/api/status` visar `"kortlankar": true` när det är på plats.
Filen säkerhetskopieras inte; kopiera den vid byte av server.

## Hemligheter (inloggning till Lantmäteriets tjänster m.m.)

Vid `deploy --data` jämförs NGP-data per kommun. Andra kommuner försvinner alltså inte när enbart en kommun importerats lokalt. Äldre SCB-underlag stoppas före databasbytet: om servern har nyare ägarkontroll eller arbetsställen måste motsvarande lokala import och build-public köras först. En kodpublicering utan `--data` påverkas inte. SCB-hämtningstider skrivs bara för fullständiga importer, inte för provuttag med `--sidor`.

### Daglig datauppdatering

Efter publicering installeras den dagliga körningen en gång som root i serverkonsolen:

```sh
bash /opt/fastighetskarta/current/deploy/installera-uppdatering.sh
```

`horos-uppdatering.timer` kör varje dag klockan 06:15 svensk tid, med högst tio minuters spridning. En missad körning tas igen när servern startar. Installationen aktiverar schemat och startar om appen, men gör ingen omedelbar datahämtning. Provkör som root med `systemctl start horos-uppdatering.service`. Se resultatet med `journalctl -u horos-uppdatering.service -n 100 --no-pager`.

Körningen hämtar planer, bestämmelser och dokument för de kommuner som redan importerats från NGP. `NGP_KOMMUNER` i secrets.env kan ange en annan lista med fyrsiffriga kommunkoder, separerade med komma. Geotorget-uppgifterna läses från befintliga secrets.env av systemd och skrivs aldrig i loggen.

Nyheter från Cision/Fastighetsvärlden och mottagna MFN-meddelanden behandlas också. Den befintliga nyhetskörningen två gånger per dag finns kvar; körningarna delar lås och kan inte skriva samtidigt.

SCB:s ägarkontroll uppdateras när `SCB_API_KEY` finns i secrets.env. Arbetsställen kräver dessutom riktiga fastigheter och `HOROS_SCB_VILLKOR=1`, som markerar att publiceringsvillkoren är uppfyllda. Nycklar anges av användaren i terminalen via den befintliga hemlighetshanteringen, aldrig i chatten. Saknade inställningar visas som väntande källor, inte som lyckade hämtningar.

Fastighetsgränser, ägare, köpeskillingar, taxering, fullständigt bolagsregister, adresser, förorenade och utsatta områden samt flygfoton har ännu ingen automatisk hämtning i detta jobb. De befintliga importerarna för dessa källor ändras inte. Nya myndighetsuttag/filer och en särskild koppling till respektive källa behövs fortfarande. SCB:s ägarkontroll är inte samma sak som uppdatering av lagfarna fastighetsägare.

Uppdateringen arbetar på en kopia. Ett fel före databasbytet lämnar livefilen orörd. Om hälsokontrollen efter bytet misslyckas återställs föregående databas. Gamla databaser komprimeras i `/var/lib/fastighetskarta/arkiv`. De 14 senaste behålls och äldre raderas (användarens beslut 2026-10-21); misslyckade körningar komprimeras och de 5 senaste behålls. Jobbet avbryts ändå innan ledigt utrymme blir för litet.

Dokumenten lagras i `/var/lib/fastighetskarta/plandokument`, utanför kodversionerna. Appens drop-in pekar dit; om en fil bara finns i det senast publicerade paketet används den som reserv. En lokal `deploy --data` behåller serverns nyare NGP-planer utifrån källans hämtningstid. `/api/status` anger senaste lyckade uppdatering och status per källa. En redan öppen karta hämtar aktuella kartdata var femte minut när fliken är synlig och när användaren återvänder till fliken.

Hemligheter skickas direkt från din terminal till servern och sparas i
`/etc/fastighetskarta/secrets.env` (läsbar bara för root och Horos-tjänsten). Skriv dem aldrig
i chatten, i koden eller i ett kommando.

Geotorget-inloggningen (för historiska flygfoton) läggs in med ett skript som frågar efter
lösenordet dolt och skickar det över SSH:

```sh
node scripts/login-till-server.mjs deploy@<IP> <geotorget-användarnamn>
```

Lokalt startas servern med samma inloggning via `node scripts/dev-med-login.mjs <användarnamn>`.

`fastighetskarta-admin list-secrets` visar vilka namn som finns (aldrig värdena).
Kräver serverkonfiguration version 2.

## Byta till en ny server

Skapa den nya servern bredvid den gamla (steg 2 med aktuell `cloud-init.yaml`), publicera med
`deploy.sh --data`, kontrollera att allt fungerar, lägg in hemligheter igen och ta först
därefter bort den gamla servern i Hetzner. Kontrollera installationen med:

```sh
ssh deploy@<ny IP> sudo -n /usr/local/sbin/fastighetskarta-admin versions
```

## Felsökning

```sh
ssh deploy@<IP> sudo /usr/local/sbin/fastighetskarta-admin status
ssh deploy@<IP> sudo /usr/local/sbin/fastighetskarta-admin logs 100
```

Backa till föregående version (de tre senaste sparas):

```sh
ssh deploy@<IP> 'ls -1dt /opt/fastighetskarta/releases/*'
ssh deploy@<IP> 'ln -sfn /opt/fastighetskarta/releases/<äldre> /opt/fastighetskarta/current && sudo /usr/local/sbin/fastighetskarta-admin restart'
```

## Vad som är uppsatt på servern

| Del | Detalj |
|---|---|
| Användare | `deploy` (bara SSH-nyckel, får bara köra `fastighetskarta-admin` som root); `fastighetskarta` (kör appen, ingen inloggning) |
| SSH | root- och lösenordsinloggning avstängda |
| Brandvägg | ufw: bara 22, 80, 443 |
| Uppdateringar | automatiska säkerhetsuppdateringar (unattended-upgrades) |
| App | Node 24, systemd-tjänst med härdning (skrivskyddat filsystem, inga privilegier), lyssnar bara på 127.0.0.1:3000 |
| Webbserver | Caddy: HTTPS, komprimering, säkerhetshuvuden (CSP m.m.), ingen åtkomstlogg |
| Data | `/var/lib/fastighetskarta/public.sqlite`, öppnas skrivskyddat |
| Scenarier | `/var/lib/horos-scenarion/scenarion.sqlite`, det enda appen skriver utöver kartcachen |
| Cron (deploy) | `deploy/nyheter.sh` 05:15 och 15:15 UTC: nya pressmeddelanden från Cision och det MFN skickat till `/api/mfn` (`/var/lib/horos-scenarion/mfn.sqlite`), byter databasen och startar om om något ändrats; logg i `/var/lib/fastighetskarta/nyheter.log` (läggs in av `deploy.sh`) |
| Integritet | Inga besökar-IP:n loggas; MapLibre serveras från egen server. Bakgrundskartan hämtas från OpenFreeMap (tredje part: besökarens webbläsare kontaktar deras servrar) |
