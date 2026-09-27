#!/bin/sh
# Garage-Bootstrap für die DEV-Stacks (Bughunt-Entscheidung 4.1) — das
# Gegenstück zu infra/self-host/garage-init.sh, nur von HOST-Seite: das
# dxflrs/garage-Image trägt KEINE Shell, ein Init-Container scheidet daher
# aus; dev-up.fish ruft dieses Skript nach `docker compose up -d` auf.
#
# Schritte (idempotent):
#   1. auf den Garage-Daemon warten,
#   2. Single-Node-Layout zuweisen (10G Dev-Kopfbinde) + anwenden,
#   3. Bucket pulse-attachments anlegen,
#   4. S3-Key anlegen und Credentials nach .garage-dev-credentials
#      schreiben (gitignored). Garage erzwingt GK-Format (minioadmin ist
#      als Key-ID ungueltig) und zeigt das Secret nur EINMAL bei der
#      Erzeugung — deshalb die Datei. dev-up.fish exportiert sie danach
#      als S3_ACCESS_KEY/S3_SECRET_KEY fuer die uvicorn-Services.
# Aufruf: sh scripts/dev-garage-init.sh   (vom Repo-Root, compose-Projekt
# muss laufen; bei dev-remote: dort aufrufen und die Datei-Werte ins .env
# uebernehmen — s. infra/dev-remote/README.md §2b)
set -u
CREDS_FILE=.garage-dev-credentials

i=0
# 60 s statt 30: direkt nach dev-up kämpfen alle Container gleichzeitig um
# Startzeit — Garage war damit 2026-09-22 trotz intaktem Zustand über die
# 30-s-Schleife hinweg weg und das Bootstrap schlug scheinbar fehl.
while [ "$i" -lt 60 ]; do
  if docker compose exec -T garage /garage status >/dev/null 2>&1; then break; fi
  i=$((i + 1))
  sleep 1
done
if ! docker compose exec -T garage /garage status >/dev/null 2>&1; then
  echo "[garage-init] garage daemon nicht erreichbar — gebe auf" >&2
  exit 1
fi

node=$(docker compose exec -T garage /garage status 2>/dev/null | awk 'NR>2 && NF>3 {print $1; exit}')
[ -n "$node" ] || node=$(docker compose exec -T garage /garage node id 2>/dev/null | awk '{print $1}')

docker compose exec -T garage /garage layout assign -z dc1 -c 10G "$node" 2>/dev/null || true
# Nur die ZEILE "Current cluster layout version: N" parsen — die Usage-
# Hilfe ("garage layout apply --version 1") enthaelt auch "version" und
# liess `tail -1` sonst die Versions-NUMMER aus der Hilfe ziehen (Bughunt
# Runde 42: der Bootstrap scheiterte damit mit "Invalid new layout
# version", die Rolle blieb fuer immer im Staging).
ver=$(docker compose exec -T garage /garage layout show 2>/dev/null | awk '/Current cluster layout version/ {print $NF; exit}')
[ -n "$ver" ] && docker compose exec -T garage /garage layout apply --version $((ver + 1)) 2>/dev/null

docker compose exec -T garage /garage bucket create pulse-attachments 2>/dev/null || true

# --- S3-Key ---------------------------------------------------------------
if [ -f "$CREDS_FILE" ] && grep -q '^GARAGE_S3_KEY=' "$CREDS_FILE"; then
  . "$CREDS_FILE"
else
  erstellung=$(docker compose exec -T garage /garage key create pulse 2>/dev/null)
  GARAGE_S3_KEY=$(printf '%s\n' "$erstellung" | awk '/^Key ID:/ {print $3}')
  GARAGE_S3_SECRET=$(printf '%s\n' "$erstellung" | awk '/^Secret key:/ {print $3}')
  if [ -z "$GARAGE_S3_KEY" ] || [ -z "$GARAGE_S3_SECRET" ]; then
    echo "[garage-init] Key-Erzeugung unlesbar (Key existiert schon? -> garage key list)" >&2
    exit 1
  fi
  {
    echo "# Von scripts/dev-garage-init.sh erzeugt — wird von dev-up.fish als"
    echo "# S3_ACCESS_KEY/S3_SECRET_KEY exportiert. NICHT committen."
    echo "GARAGE_S3_KEY=$GARAGE_S3_KEY"
    echo "GARAGE_S3_SECRET=$GARAGE_S3_SECRET"
  } > "$CREDS_FILE"
  chmod 600 "$CREDS_FILE"
fi

# --owner: der Key braucht Admin-Rechte am Bucket, um die CORS-Regel unten
# setzen zu können ("Operation is not allowed for this key" ohne das Flag).
docker compose exec -T garage /garage bucket allow --read --write --owner pulse-attachments --key "$GARAGE_S3_KEY" 2>/dev/null || true

# --- CORS -----------------------------------------------------------------
# Garage hat im Gegensatz zu MinIO KEINE tolerante CORS-Voreinstellung —
# ohne Regel lehnt es Preflights ab ("This CORS request is not allowed") und
# Laufwerk/Ablage sterben im Browser mit "blocked by CORS policy" (2026-09-22).
# Genau EINE Origin pro Regel und zwar '*': Garage klebt ALLE AllowedOrigins
# kommagetrennt in DEN einen Access-Control-Allow-Origin-Header — der CORS-
# Standard erlaubt dort aber nur genau einen Wert oder '*', der Browser lehnt
# 'http://a, http://b' als "contains multiple values" ab. Presigned URLs
# schleppen keine Credentials, darum ist '*' hier unkritisch.
# Die Regel liegt im Bucket-Metadaten-Volumen und überlebt Neustarts; dieser
# Block stellt sie nur bei frischem Volumen wieder her. uv ist ohnehin
# Dev-Voraussetzung (dev-up-Frachtflug); --with installiert aiobotocore nur
# in einen Cache und fasst die Services nicht an.
uv run --with aiobotocore python - "$GARAGE_S3_KEY" "$GARAGE_S3_SECRET" <<'EOF' 2>/dev/null || echo "[garage-init] WARN: CORS-Regel nicht gesetzt — Laufwerk/Ablage im Browser ggf. CORS-blockiert" >&2
import sys, asyncio, aiobotocore.session
key, secret = sys.argv[1], sys.argv[2]

async def main():
    session = aiobotocore.session.get_session()
    async with session.create_client(
        's3', endpoint_url='http://localhost:9000', region_name='us-east-1',
        aws_access_key_id=key, aws_secret_access_key=secret) as client:
        try:
            current = await client.get_bucket_cors(Bucket='pulse-attachments')
            if any('*' in o for r in current.get('CORSRules', [])
                   for o in r.get('AllowedOrigins', [])):
                return  # Regel steht schon — idempotent.
        except Exception:
            pass  # NoSuchCORSConfiguration = noch keine Regel da.
        await client.put_bucket_cors(Bucket='pulse-attachments', CORSConfiguration={
            'CORSRules': [{
                'AllowedMethods': ['GET', 'PUT', 'HEAD'],
                'AllowedOrigins': ['*'],
                'AllowedHeaders': ['*'], 'MaxAgeSeconds': 3600}]})
        print('[garage-init] CORS-Regel gesetzt (Origin *)')

asyncio.run(main())
EOF

echo "[garage-init] bootstrap fertig (Layout, Bucket pulse-attachments, Key $GARAGE_S3_KEY; Credentials: $CREDS_FILE)"
