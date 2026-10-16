#!/bin/bash
# Flygfoto för hela landet (Lantmäteriets ortofoto). Körs som root i Hetzners webbkonsol (inga Skift-tecken):
#   bash /opt/fastighetskarta/current/deploy/ortofoto.sh
# Installerar rasterio (Python), bygger registret över bilderna (~30 min, bara metadata från
# Lantmäteriets katalog) och startar om appen. Kör om när Lantmäteriet publicerat nya flygningar.
# Rutorna ritas sedan vid behov av appen och sparas i /var/cache/fastighetskarta/ortofoto.
set -euo pipefail
python3 -c 'import rasterio' 2>/dev/null \
  || { apt-get update -q && DEBIAN_FRONTEND=noninteractive apt-get install -y -q python3-rasterio; }
cd /opt/fastighetskarta/current
sudo -u deploy node --disable-warning=ExperimentalWarning scripts/import-ortofoto.mjs --db /var/lib/fastighetskarta/ortofoto.sqlite
# Rutor från ett tidigare register ritas om (nya flygningar).
if [[ -d /var/cache/fastighetskarta/ortofoto ]]; then
  mv /var/cache/fastighetskarta/ortofoto /var/cache/fastighetskarta/ortofoto_GAMMAL_$(date +%Y%m%d%H%M)
  echo "Gamla rutor flyttade till /var/cache/fastighetskarta/ortofoto_GAMMAL_*; ta bort dem när du vill."
fi
systemctl restart fastighetskarta
echo "Klart. Välj Flygfoto i kartans bakgrundsväljare."
