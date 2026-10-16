#!/bin/bash
# Flygfoto för hela landet (Lantmäteriets ortofoto). Körs som root i Hetzners webbkonsol (inga Skift-tecken):
#   systemd-run --unit horos-ortofoto bash /opt/fastighetskarta/current/deploy/ortofoto.sh
# (Om en tidigare körning misslyckats: systemctl reset-failed horos-ortofoto först.)
# Installerar rasterio (Python), bygger registret över bilderna (~10–20 min, bara metadata från
# Lantmäteriets katalog) och startar om appen. Kör om när Lantmäteriet publicerat nya flygningar.
# Rutorna ritas sedan vid behov av appen och sparas i /var/cache/fastighetskarta/ortofoto; Stockholm
# (zoom 14–17) ritas i förväg i slutet (1–2 timmar, appen fungerar under tiden).
set -euo pipefail
python3 -c 'import rasterio' 2>/dev/null \
  || { apt-get update -q && DEBIAN_FRONTEND=noninteractive apt-get install -y -q python3-rasterio; }
cd /opt/fastighetskarta/current
sudo -u deploy node --disable-warning=ExperimentalWarning scripts/import-ortofoto.mjs --db /var/lib/fastighetskarta/ortofoto.sqlite
# Appen stoppas medan cachen flyttas, så att inga rutor från det gamla registret hamnar i den nya.
systemctl stop fastighetskarta
if [[ -d /var/cache/fastighetskarta/ortofoto ]]; then
  mv /var/cache/fastighetskarta/ortofoto /var/cache/fastighetskarta/ortofoto_GAMMAL_$(date +%Y%m%d%H%M)
  echo "Gamla rutor flyttade till /var/cache/fastighetskarta/ortofoto_GAMMAL_*; ta bort dem när du vill."
fi
systemctl start fastighetskarta
echo "Registret är klart. Välj Flygfoto i kartans bakgrundsväljare. Ritar Stockholm i förväg…"
sleep 5
sudo -u deploy node --disable-warning=ExperimentalWarning scripts/forrita-ortofoto.mjs
