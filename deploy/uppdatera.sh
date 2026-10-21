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
# Användarens beslut 2026-10-21: de 14 senaste arkiven behålls och äldre raderas, liksom allt utom de 5 senaste
# misslyckade körningarna (2,1 GB per databas; allt kan byggas om från arbetskopian och källorna).
rensa() {
  { ls -1t "$arkiv"/public-*.sqlite_GAMMAL.gz 2>/dev/null || true; } | tail -n +15 | xargs -r rm -f --
  { ls -1t "$arkiv"/*_MISSLYCKAD.gz 2>/dev/null || true; } | tail -n +6 | xargs -r rm -f --
}
# Lämna marginal för arbetskopia och återställning. Stoppa uppdateringen före full disk.
storlek=$(stat -c %s "$D/public.sqlite")
ledigt=$(df -B1 --output=avail "$D" | tail -1)
(( ledigt > 3 * storlek + 2147483648 )) || { echo 'För lite diskutrymme för säker uppdatering.'; exit 1; }
cp "$D/public.sqlite" "$arbete"
export HOROS_UPPDATERING_ARBETE="$arbete"
export NGP_DOKUMENT_DIR="$D/plandokument"
if ! node --disable-warning=ExperimentalWarning scripts/uppdatera-data.mjs "$arbete"; then
  for f in "$arbete" "$arbete-wal" "$arbete-shm"; do
    [[ ! -f $f ]] || { mv "$f" "$arkiv/$(basename "$f")_MISSLYCKAD"; gzip -f "$arkiv/$(basename "$f")_MISSLYCKAD"; }
  done
  rensa
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
  gzip -f "$arkiv/public-$stamp.sqlite_MISSLYCKAD" "$gammal"
  rensa
  echo 'Hälsokontrollen misslyckades. Den gamla databasen återställdes.'
  exit 1
fi
# Arkivet: komprimera och behåll de 14 senaste.
gzip "$gammal"
rensa
echo "Uppdateringen klar: $stamp. Tidigare data finns i $gammal.gz."
