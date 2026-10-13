#!/usr/bin/env bash
# Horos – tak för serverns utgående trafik. Hetzner tar betalt (~1 €/TB) för trafik över 20 TB
# per månad. 50 Mbit/s dygnet runt i 31 dygn är högst 16,7 TB, så taket kan aldrig ge en
# trafikräkning; under en attack blir sajten långsam i stället för dyr.
#
# Installera en gång som root (Hetzners webbkonsol; inga Skift-tecken):
#   bash /opt/fastighetskarta/current/deploy/trafiktak.sh installera
# Ta bort:
#   systemctl disable --now horos-trafiktak
#   tc qdisc del dev eth0 root
set -euo pipefail

TAK="${TRAFIKTAK:-50mbit}"
DEV="$(ip -o route show default | awk '{print $5; exit}')"
[[ -n "$DEV" ]] || { echo 'Hittar inget nätverkskort med standardväg.'; exit 1; }

if [[ "${1:-}" == installera ]]; then
  install -m 755 "$0" /usr/local/sbin/horos-trafiktak
  cat > /etc/systemd/system/horos-trafiktak.service <<'EOF'
[Unit]
Description=Horos: tak för utgående trafik
Wants=network-online.target
After=network-online.target

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/local/sbin/horos-trafiktak

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
  systemctl enable --now horos-trafiktak.service
  tc class show dev "$DEV"
  exit
fi

# All utgående trafik i en klass med taket; fq_codel håller kön kort så att sidorna svarar snabbt.
tc qdisc replace dev "$DEV" root handle 1: htb default 10
tc class replace dev "$DEV" parent 1: classid 1:10 htb rate "$TAK" ceil "$TAK"
tc qdisc replace dev "$DEV" parent 1:10 fq_codel
