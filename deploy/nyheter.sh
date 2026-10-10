#!/bin/bash
# Hämtar nya pressmeddelanden till den publika databasen på servern. Körs av cron som deploy
# (crontab läggs in av deploy.sh). Arbetar på en kopia och byter filen atomärt, som deploy --data,
# och startar om appen så att den läser den nya filen.
set -euo pipefail
cd /opt/fastighetskarta/current
D=/var/lib/fastighetskarta
inode=$(stat -c %i $D/public.sqlite)
cp $D/public.sqlite $D/nyheter-arbete.sqlite
trap 'rm -f $D/nyheter-arbete.sqlite $D/nyheter-arbete.sqlite-journal' EXIT
out=$(node --disable-warning=ExperimentalWarning scripts/import-nyheter.mjs --publik $D/nyheter-arbete.sqlite 2>&1) \
  || { echo "$(date -Is) Fel, sparar inte: $out"; exit 1; }
echo "$(date -Is) $out"
# En deploy --data under tiden har bytt filen: behåll den (nästa körning hämtar nyheterna).
[[ $(stat -c %i $D/public.sqlite) == "$inode" ]] || { echo "Databasen byttes under körningen, sparar inte."; exit 0; }
mv $D/nyheter-arbete.sqlite $D/public.sqlite
sudo -n /usr/local/sbin/fastighetskarta-admin restart
