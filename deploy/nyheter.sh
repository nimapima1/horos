#!/bin/bash
# Hämtar nya pressmeddelanden till den publika databasen på servern. Körs av cron som deploy
# (crontab läggs in av deploy.sh). Arbetar på en kopia och byter filen atomärt, som deploy --data,
# och startar om appen så att den läser den nya filen (bara om något ändrades).
set -euo pipefail
cd /opt/fastighetskarta/current
D=/var/lib/fastighetskarta
# Samma lås som deploy.sh tar när den byter databasen: aldrig två som skriver samtidigt.
exec 9>$D/databas.lock
flock -n 9 || { echo "$(date -Is) Upptaget (deploy eller en annan körning), hoppar över."; exit 0; }
# En app som stoppats med avsikt (t.ex. efter ett fel i datan) ska inte startas av cron.
systemctl is-active --quiet fastighetskarta || { echo "$(date -Is) Appen är stoppad, hoppar över."; exit 0; }
trap 'rm -f $D/nyheter-arbete.sqlite $D/nyheter-arbete.sqlite-journal' EXIT
cp $D/public.sqlite $D/nyheter-arbete.sqlite
# Importen på kopian: slutkod 0 = något ändrades, 3 = inget nytt, annat = fel (då sparas inget).
andrat=0
kor() {
  local rc=0 out
  out=$(node --disable-warning=ExperimentalWarning scripts/import-nyheter.mjs --publik $D/nyheter-arbete.sqlite "$@" 2>&1) || rc=$?
  echo "$(date -Is) $out"
  [[ $rc == 0 ]] && andrat=1
  [[ $rc == 0 || $rc == 3 ]] || { echo "Fel (slutkod $rc), sparar inte."; exit 1; }
}
kor                                    # Cision
# Det som MFN skickat till /api/mfn (appen skriver i sin StateDirectory, samma som scenarierna).
MFN=/var/lib/horos-scenarion/mfn.sqlite
if [[ -f $MFN ]]; then kor --mfn $MFN; fi
[[ $andrat == 1 ]] || exit 0           # inget ändrades: ingen omstart
mv $D/nyheter-arbete.sqlite $D/public.sqlite
sudo -n /usr/local/sbin/fastighetskarta-admin restart
sleep 5
curl -fsS -o /dev/null http://127.0.0.1:3000/api/status || { echo "$(date -Is) Appen svarar inte efter omstarten."; exit 1; }
