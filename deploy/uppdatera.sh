#!/bin/bash
# Daglig uppdatering. Körs av horos-uppdatering.service, med secrets.env via systemd.
set -euo pipefail
cd /opt/fastighetskarta/current
D=/var/lib/fastighetskarta
exec 9>$D/databas.lock
flock -n 9 || { echo 'En annan uppdatering eller deploy pågår. Hoppar över.'; exit 0; }
systemctl is-active --quiet fastighetskarta || { echo 'Appen är stoppad. Hoppar över.'; exit 0; }
stamp=$(date -u +%Y%m%dT%H%M%S)
arbete=$D/uppdatering-$stamp.sqlite
arkiv=$D/arkiv
mkdir -p "$arkiv"
# Lämna marginal för arbetskopia och återställning. Stoppa uppdateringen före full disk.
storlek=$(stat -c %s "$D/public.sqlite")
ledigt=$(df -B1 --output=avail "$D" | tail -1)
(( ledigt > 3 * storlek + 2147483648 )) || { echo 'För lite diskutrymme för säker uppdatering.'; exit 1; }
cp "$D/public.sqlite" "$arbete"
export HOROS_UPPDATERING_ARBETE="$arbete"
export NGP_DOKUMENT_DIR="$D/plandokument"
if ! node --disable-warning=ExperimentalWarning scripts/uppdatera-data.mjs "$arbete"; then
  for f in "$arbete" "$arbete-wal" "$arbete-shm"; do
    [[ ! -f $f ]] || mv "$f" "$arkiv/$(basename "$f")_MISSLYCKAD"
  done
  echo 'Uppdateringen misslyckades. Den tidigare databasen används fortfarande.'
  exit 1
fi
chmod 644 "$arbete"
gammal=$arkiv/public-$stamp.sqlite_GAMMAL
cp "$D/public.sqlite" "$gammal"
mv "$arbete" "$D/public.sqlite"
if ! systemctl restart fastighetskarta || ! curl --retry 5 --retry-delay 2 --retry-connrefused -fsS -o /dev/null http://127.0.0.1:3000/api/status; then
  mv "$D/public.sqlite" "$arkiv/public-$stamp.sqlite_MISSLYCKAD"
  cp "$gammal" "$D/public.sqlite"
  chmod 644 "$D/public.sqlite"
  systemctl restart fastighetskarta
  echo 'Hälsokontrollen misslyckades. Den gamla databasen återställdes.'
  exit 1
fi
# Arkivet bevaras. Komprimering sparar utrymme utan att historiken försvinner.
gzip "$gammal"
echo "Uppdateringen klar: $stamp. Tidigare data finns i $gammal.gz."
