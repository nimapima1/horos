# Publicera Horos på Hetzner

Engångsuppsättning tar ungefär 20 minuter. Därefter räcker ett kommando för varje uppdatering.

Servern heter `horos-3` i Hetzner (Helsingfors, 37.27.152.172). Internt på servern heter tjänst, kataloger och
admin-skript `fastighetskarta`, t.ex. `/opt/fastighetskarta` och `fastighetskarta-admin`.

Serverkonfiguration: [`cloud-init.yaml`](cloud-init.yaml) version 3. Caddy installeras från
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
   serverns IPv4/IPv6.
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

Med Lantmäteriets data när ansökan beviljats:

```sh
node scripts/build-public.mjs --lm-beslut <ärendenummer>
deploy/deploy.sh deploy@<IP> --data
```

## Hemligheter (inloggning till Lantmäteriets tjänster m.m.)

Hemligheter skickas direkt från din terminal till servern och sparas i
`/etc/fastighetskarta/secrets.env` (läsbar bara för root och Horos-tjänsten). Skriv dem aldrig
i chatten, i koden eller i ett kommando. Kommandot nedan frågar efter värdet utan att visa det:

```powershell
$v = Read-Host -AsSecureString "Värde"; [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($v)) | ssh deploy@<IP> sudo -n /usr/local/sbin/fastighetskarta-admin set-secret NAMN
```

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
| Integritet | Inga besökar-IP:n loggas; MapLibre serveras från egen server. Bakgrundskartan hämtas från OpenFreeMap (tredje part: besökarens webbläsare kontaktar deras servrar) |
