#!/bin/bash
# Bygger ortofotorutor på servern (scripts/bygg-ortofoto.mjs). Körs som root i Hetzners webbkonsol
# (inga Skift-tecken):
#   bash /opt/fastighetskarta/current/deploy/ortofoto.sh orto-o2-2025
# Jobbet startar som en egen systemd-enhet, så det går vidare om konsolen stängs. Följ:
#   journalctl -u horos-ortofoto -f
# Tar ett par timmar; appen startas om när det är klart.
set -euo pipefail
SAMLING="${1:?Ange samlingen, t.ex. orto-o2-2025}"
if [[ -z "${HOROS_ORTOFOTO:-}" ]]; then
  # systemd läser secrets.env på samma sätt som för appen (bash skulle tolka $ i lösenordet).
  systemd-run --unit horos-ortofoto -p EnvironmentFile=/etc/fastighetskarta/secrets.env \
    --setenv HOROS_ORTOFOTO=1 bash "$(realpath "$0")" "$SAMLING"
  echo "Startat. Följ med: journalctl -u horos-ortofoto -f"
  exit 0
fi
TILES_DIR=/var/lib/fastighetskarta/tiles
# Källfiler (~3 GB) och rutor (~3 GB) för Stockholm; lämna marginal till databasen och cachen.
ledigt=$(df --output=avail -BG /var/lib/fastighetskarta | tail -1 | tr -dc 0-9)
(( ledigt >= 15 )) || { echo "Bara ${ledigt} GB ledigt, behöver 15."; exit 1; }
command -v gdal2tiles.py >/dev/null || command -v gdal2tiles >/dev/null \
  || { apt-get update -q && DEBIAN_FRONTEND=noninteractive apt-get install -y -q gdal-bin python3-gdal; }
cd /opt/fastighetskarta/current
TILES_DIR=$TILES_DIR nice -n 15 node --disable-warning=ExperimentalWarning scripts/bygg-ortofoto.mjs --samling "$SAMLING"
chown -R deploy:deploy $TILES_DIR
systemctl restart fastighetskarta
echo "Klart, appen omstartad."
