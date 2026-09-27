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
# Nur die ZEILE "Current cluster layout version: N" parsen — die Usage-
# Hilfe ("garage layout apply --version 1") enthaelt auch "version" und
# liess `tail -1` sonst die Versions-NUMMER aus der Hilfe ziehen (Bughunt
# Runde 42: der Bootstrap scheiterte damit mit "Invalid new layout
# version", die Rolle blieb fuer immer im Staging).
ver=$("$G" -c "$CF" layout show 2>/dev/null | awk '/Current cluster layout version/ {print $NF; exit}')
[ -n "$ver" ] && "$G" -c "$CF" layout apply --version $((ver + 1)) 2>/dev/null

"$G" -c "$CF" bucket create pulse-attachments 2>/dev/null || true

# Garage-Key-IDs müssen GK + 24 Hex sein; Installationen aus MinIO-Zeiten
# haben "pulse-…"-IDs in jwt_keys/minio.user — `key import` lehnt die ab
# ("Invalid key format", 2026-09-22). Frische Instanzen erzeugen direkt
# GK-IDs (03-init-secrets.sh); für Bestandsinstanzen erzeugen wir hier
# einmalig einen Schlüssel, persistieren ihn anstelle des alten in
# jwt_keys (07-render-env.sh liest genau diese Dateien) und patchen
# env.sh für den aktuellen Boot — chat-gateway startet wegen seiner
# s6-Abhängigkeit erst NACH garage-init und liest die gepatchte Datei.
# PULSE_DATA_PATH/PULSE_ENV_SH sind Überschreib-Haken für die Tests.
s3_key_sicherstellen() {
  DATA="${PULSE_DATA_PATH:-/data}"
  KEYS="${DATA}/jwt_keys"
  ENV_SH="${PULSE_ENV_SH:-/etc/pulse/env.sh}"
  case "$S3_ACCESS_KEY" in
    GK*)
      "$G" -c "$CF" key import --yes "$S3_ACCESS_KEY" "$S3_SECRET_KEY" -n pulse 2>/dev/null || true
      ;;
    *)
      out=$("$G" -c "$CF" key create pulse 2>/dev/null) || out=""
      new_id=$(printf '%s\n' "$out" | grep -oE 'GK[0-9a-f]{24}' | head -1)
      new_sk=$(printf '%s\n' "$out" | sed -n 's/^Secret key:[[:space:]]*//p')
      if [ -n "$new_id" ] && [ -n "$new_sk" ]; then
        printf '%s' "$new_id" > "${KEYS}/minio.user"
        printf '%s' "$new_sk" > "${KEYS}/minio.password"
        chmod 0600 "${KEYS}/minio.user" "${KEYS}/minio.password"
        sed -i "s|^export S3_ACCESS_KEY=.*|export S3_ACCESS_KEY='${new_id}'|; s|^export S3_SECRET_KEY=.*|export S3_SECRET_KEY='${new_sk}'|" "$ENV_SH"
        S3_ACCESS_KEY="$new_id"; S3_SECRET_KEY="$new_sk"
        echo "[garage-init] Legacy-S3-Key ersetzt durch ${new_id}"
      else
        echo "[garage-init] WARNUNG: kein GK-Key erzeugbar — Signaturen werden 403 sein" >&2
      fi
      ;;
  esac
}
s3_key_sicherstellen
"$G" -c "$CF" bucket allow --read --write pulse-attachments --key "$S3_ACCESS_KEY" 2>/dev/null || true

echo "[garage-init] bootstrap fertig (Layout, Bucket pulse-attachments, Key)"
