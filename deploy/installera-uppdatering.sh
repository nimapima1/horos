#!/bin/bash
# Kör en gång som root efter publicering. Ändrar inga hemligheter.
set -euo pipefail
cd /opt/fastighetskarta/current
install -d -m 755 /var/lib/fastighetskarta/plandokument
shopt -s nullglob
for pdf in public/plandokument/*.pdf; do
  target=/var/lib/fastighetskarta/plandokument/$(basename "$pdf")
  [[ -f $target ]] || cp "$pdf" "$target"
  chmod 644 "$target"
done
install -m 644 deploy/horos-uppdatering.service /etc/systemd/system/horos-uppdatering.service
install -m 644 deploy/horos-uppdatering.timer /etc/systemd/system/horos-uppdatering.timer
install -d /etc/systemd/system/fastighetskarta.service.d
echo '[Service]
Environment=NGP_DOKUMENT_DIR=/var/lib/fastighetskarta/plandokument' > /etc/systemd/system/fastighetskarta.service.d/dokument.conf
systemctl daemon-reload
systemctl enable --now horos-uppdatering.timer
systemctl restart fastighetskarta
systemctl list-timers horos-uppdatering.timer --no-pager
