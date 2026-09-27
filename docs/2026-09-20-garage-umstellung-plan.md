# Garage-Umstellung (ersetzt MinIO komplett) — Umsetzungsplan

Entscheidung 2026-09-20 (Option 3 aus dem Bughunt-Doc): MinIO fliegt
komplett — Prod UND Self-Host — und wird durch **Garage** (S3-kompatibel,
ein Rust-Binary, Apache-2.0-Community-Fork dxflrs) ersetzt.

## Validiert (2026-09-20, Live-Probe gegen dxflrs/garage:v1.1.0)

Die GESAMTE von Pulse genutzte S3-Oberfläche läuft unverändert gegen
Garage (`services/chat-gateway/src/dcc_chat_gateway/s3.py`):
* SigV4-presigned PUT/GET (mit signiertem Content-Type) ✔
* PutObject / HeadObject / GetObject-Streaming / DeleteObject ✔
* ListObjectsV2-Paginator ✔
Kein Code-Change in `s3.py` nötig — nur Konfiguration (Region, Keys,
Endpoint). Zusätzlich bestätigt: `garage key import <access> <secret>`
existiert (v1.1.0), d. h. die heute generierten S3-Credentials können
1:1 importiert werden — chat-gateway bleibt unangetastet.

## Kompatibilität mit dem ungemergten Ablage-Verschlüsselungs-Zweig

`origin/feat/nextcloud-kanal-server-festigung` (27 Commits; „Nextcloud-
Kanäle legt Pulse selbst ab" + verschlüsselte Textkanäle; plus Stash
`origin/wip/nextcloud-speicher-stash`, „pulse-speicher Klient-Teil,
WIP") schreibt die E2E-Kanal-Umschläge über den **Nutzer-Laufwerk-
Weiterreicher** (`ablage_schreiben.py`, WebDAV-MKCOL/PUT gegen
Nextcloud bzw. S3 des Nutzers) — NICHT über das interne MinIO. Die
Garage-Umstellung berührt nur den INTERNEN S3-Endpunkt → keine
Kollision, aber der Zweig (27 Commits hinter/main-voraus-Mix) braucht
nach dem Umstieg ein Rebase auf den neuen Stand.

## Umsetzung

### 1. Self-Host (all-in-one) — UMGESETZT (c952077f)
* Dockerfile: MinIO-Stage ersetzen durch `COPY --from=dxflrs/garage:v1.1.0
  /garage ...` (Image statt URL-Download — das 410-Problem entfällt
  strukturell; 9ac86230 wird damit überholt).
* s6: neuer Longrun `garage` + Init-Skript (idempotent):
  - garage.toml rendern (metadata/data unter /data/garage, rpc_secret
    persistiert unter KEYS/, s3_api auf 127.0.0.1:9000, region passend
    zu `S3_REGION`-Setting, admin api 3909)
  - Bootstrap: node-id lesen → layout assign (-z dc1 -c 1G) → apply →
    bucket create pulse-attachments → key import MINIO_USER/MINIO_PASS
    als „pulse" → bucket allow --read --write
  - chat-gateway env (S3_ACCESS_KEY/S3_SECRET_KEY/S3_*_ENDPOINT)
    bleibt unverändert
* Healthcheck: `garage status` bzw. HEAD auf Bucket.
* Alte MinIO-s6-Services + Dockerfile-Stage + Pins entfernen.

### 2. Prod (infra/prod/docker-compose.yml) — UMGESETZT (e95b137d)
* `minio`-Service → Garage-Container (dxflrs/garage, garage.toml
  gemountet, Ports 9000 intern). Achtung: das Hub-Image
  `minio/minio:RELEASE.2025-09-07...` ist vom Hub GELÖSCHT — Neu-Deploys
  des Prod-Stacks brechen heute ohnehin; Garage löst das.
* Backup (mc mirror gegen S3-API) funktioniert unverändert mit Garage.
* Migration: einmalig `mc mirror` vom alten MinIO-Volume in den
  Garage-Bucket (Keys bleiben Pulse-seitig identisch).

### 3. Danach
* refresh-checksums.sh: MINIO-Regeln entfernen (skript-Stub).
* docs/DEPLOY-Notizen + CLAUDE.md-Porttabelle anpassen.
