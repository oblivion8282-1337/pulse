#!/bin/sh
# Garage-Bootstrap (ersetzt init-minio-bucket.py, Bughunt-Serie Teil 3):
#  1. auf den Garage-Daemon warten,
#  2. Single-Node-Layout zuweisen + anwenden (idempotent — existierende
#     Rollen/Zuweisungen werden toleriert),
#  3. Bucket pulse-attachments anlegen (bereits vorhanden → Fehler egal),
#  4. den S3-Key mit den CREDs aus env.sh importieren (genau die, die
#     chat-gateway via S3_ACCESS_KEY/S3_SECRET_KEY signed) und am Bucket
#     freischalten.
# Alles mit `|| true`/Toleranz — ein Bootstrap-Fehler darf den Container
# nicht blocken; der nächste Boot wiederholt es.
exec 2>&1
G=/usr/local/bin/garage
CF=/etc/pulse/garage.toml

i=0
while [ $i -lt 30 ]; do
  if "$G" -c "$CF" status >/dev/null 2>&1; then break; fi
  i=$((i + 1))
  sleep 1
done
if ! "$G" -c "$CF" status >/dev/null 2>&1; then
  echo "[garage-init] garage daemon nicht erreichbar — gebe auf" >&2
  exit 0
fi

node=$("$G" -c "$CF" status 2>/dev/null | awk 'NR>2 && NF>3 {print $1; exit}')
[ -n "$node" ] || node=$("$G" -c "$CF" node id 2>/dev/null | awk '{print $1}')

"$G" -c "$CF" layout assign -z dc1 -c 1G "$node" 2>/dev/null || true
ver=$("$G" -c "$CF" layout show 2>/dev/null | awk '/[Vv]ersion/{gsub(/[^0-9]/,"",$NF); print $NF}' | tail -1)
[ -n "$ver" ] && "$G" -c "$CF" layout apply --version $((ver + 1)) 2>/dev/null

"$G" -c "$CF" bucket create pulse-attachments 2>/dev/null || true
"$G" -c "$CF" key import "$S3_ACCESS_KEY" "$S3_SECRET_KEY" -n pulse 2>/dev/null || true
"$G" -c "$CF" bucket allow --read --write pulse-attachments --key "$S3_ACCESS_KEY" 2>/dev/null || true

echo "[garage-init] bootstrap fertig (Layout, Bucket pulse-attachments, Key)"
