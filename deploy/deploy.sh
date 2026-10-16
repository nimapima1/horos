#!/usr/bin/env bash
# Publicerar Horos till servern. Kör från Git Bash i projektmappen:
#
#   deploy/deploy.sh deploy@37.27.152.172           ladda upp koden och starta om
#   deploy/deploy.sh deploy@37.27.152.172 --data    även ladda upp data/public.sqlite
#
# Bygg alltid den publika databasen först med:  npm run build:public
# Allt skickas i ett enda SSH-anrop (lösenfrasen efterfrågas en gång). Koden läggs i
# /opt/fastighetskarta/releases/<tid> och "current" pekar på den senaste; de tre senaste
# versionerna sparas så att det går att backa.
set -euo pipefail

TARGET="${1:?Ange server, t.ex. deploy@37.27.152.172}"
WITH_DATA="${2:-}"
cd "$(dirname "$0")/.."
# public/vendor fylls av "npm install" (postinstall) och laddas upp som den är.
[[ -f public/vendor/maplibre-gl-csp.js ]] || { echo "public/vendor saknas. Kör: npm install"; exit 1; }
# Windows egen ssh läser lösenfrasen korrekt i terminalpanelen; Git Bash-versionen gör inte
# det när den startas från PowerShell (inmatningen hamnar i fel fönster).
SSH=ssh
[[ -x /c/Windows/System32/OpenSSH/ssh.exe ]] && SSH=/c/Windows/System32/OpenSSH/ssh.exe

REL="$(date +%Y%m%d-%H%M%S)"
FILES=(server.mjs package.json lib public scripts/import-nyheter.mjs scripts/import-ortofoto.mjs scripts/forrita-ortofoto.mjs deploy/ortofoto.sh deploy/nyheter.sh deploy/scenarion.conf deploy/trafiktak.sh)
if [[ "$WITH_DATA" == "--data" ]]; then
  [[ -f data/public.sqlite ]] || { echo "data/public.sqlite saknas. Kör: npm run build:public"; exit 1; }
  FILES+=(data/public.sqlite)
  echo "Databas: $(du -h data/public.sqlite | cut -f1)"
fi

echo "Laddar upp version $REL till $TARGET…"
tar -czf - "${FILES[@]}" | "$SSH" "$TARGET" "set -e
  # En nyskapad server kan fortfarande installeras; vänta in den.
  cloud-init status --wait >/dev/null 2>&1 || true
  d=/opt/fastighetskarta/releases/$REL
  mkdir -p \$d && tar -xzf - -C \$d
  if [ -f \$d/data/public.sqlite ]; then
    # Samma lås som cron-jobbet deploy/nyheter.sh, och pressmeddelanden som det hämtat följer med.
    exec 9>/var/lib/fastighetskarta/databas.lock; flock 9
    if [ -f /var/lib/fastighetskarta/public.sqlite ]; then
      node --disable-warning=ExperimentalWarning \$d/scripts/import-nyheter.mjs --publik \$d/data/public.sqlite \
        --behall /var/lib/fastighetskarta/public.sqlite
    fi
    # Byt databasen atomärt så att servern aldrig läser en halv fil.
    mv \$d/data/public.sqlite /var/lib/fastighetskarta/public.sqlite.new
    mv /var/lib/fastighetskarta/public.sqlite.new /var/lib/fastighetskarta/public.sqlite
    rmdir \$d/data
  fi
  if [ ! -f /var/lib/fastighetskarta/public.sqlite ]; then
    echo 'Servern har ingen databas än. Kör: npm run build:public && deploy/deploy.sh $TARGET --data'
    rm -rf \$d; exit 1
  fi
  ln -sfn \$d /opt/fastighetskarta/current
  ls -1dt /opt/fastighetskarta/releases/* | tail -n +4 | xargs -r rm -rf
  # Pressmeddelanden två gånger om dagen (UTC, utanför omstartsfönstret 04:30), logg i nyheter.log.
  # deploy har inga andra cron-jobb, så hela crontaben skrivs om.
  echo '15 5,15 * * * bash /opt/fastighetskarta/current/deploy/nyheter.sh >> /var/lib/fastighetskarta/nyheter.log 2>&1' \
    | crontab - || echo 'cron saknas: pressmeddelandena hämtas inte automatiskt.'
  admin() { sudo -n /usr/local/sbin/fastighetskarta-admin \"\$@\"; }
  echo 'Startar om…'
  admin restart
  sleep 2
  admin status
  curl -s -o /dev/null -w 'Lokalt svar från appen: HTTP %{http_code}\n' http://127.0.0.1:3000/api/status || true
  echo '--- Installation:'
  admin versions"

echo
echo "Klart. Om tjänsten inte är 'active (running)', se loggen med:"
echo "  ssh $TARGET sudo -n /usr/local/sbin/fastighetskarta-admin logs 50"
