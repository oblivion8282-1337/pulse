# Self-Host End-to-End-Test — Befunde (2026-06-03)

Setup: netcup = Cloud (howispulse.com), Hetzner (77.42.71.166, `pulse.unicutmedia.com`) = neue
Self-Host-Instanz. Zwei Browser: A = `oblivion` (Cloud-Admin/Approver), B = `dev` (Self-Host-Owner).

Ziel: kompletten Onboarding-Flow durchspielen und jeden Mangel ausmerzen.

## Status: alle F1–F5 GEFIXT (2026-06-03, lokal verifiziert) — Image-Rebuild + erneuter Durchlauf ausstehend

Geänderte Dateien:
- `infra/self-host/s6/etc/s6-overlay/scripts/07-render-env.sh` — rendert `PULSE_INSTANCE_ID` (F2) + Pairing-Kommentar (F5)
- `infra/self-host/s6/etc/s6-overlay/scripts/10-check-cloud-creds.sh` — `PULSE_INSTANCE_ID` Pflicht (F2)
- `infra/self-host/.env.example` — `PULSE_INSTANCE_ID` aufgenommen, Zähler 4→6, Pairing-Hinweis (F2/F5)
- `services/auth/src/dcc_auth/routes_instance_applications.py` — Snippet: korrekte Var-Namen + OWNER_ID/HOSTNAME/EMAIL, WORKER_IDs raus (F3/F4/F5)
- `services/auth/tests/test_instance_applications_me.py` — Snippet-Assertions ans neue Format
- `web/src/lib/components/admin/AdminInstances.svelte` + `AdminInstancesPending.svelte` + `web/messages/{de,en}.json` — Pending-Badge (F1)
- `docs/SELF_HOST.md` + `infra/self-host/README.md` — docker-run-Beispiele vervollständigt

Tests: auth-Suite 362 passed · `pnpm check` 0/0 · `pnpm build` ok · Shell-Scripts Syntax+Render+Check verifiziert.

## Befunde

### F1 — Admin erfährt nicht von neuen Self-Host-Anträgen  [BESTÄTIGT, UX]
- **Symptom:** `dev` reicht Antrag ein → `oblivion` (Admin) bekommt nichts mit (keine Mail, kein
  Push, kein In-App-Hinweis, kein Badge/Counter am Admin-Panel/„Instanzen"-Tab).
- **Code:** `routes_instance_applications.py::POST /me/instance-applications` published/mailt nichts
  Richtung Admin. `AdminInstances*.svelte` + `/app/admin/+page.svelte` haben keinen Pending-Counter.
- **Fix-Idee:** Badge mit Pending-Count am „Instanzen"-Tab (billigster Gewinn) + optional Mail an
  Cloud-Admins. Mindestens ein unaufdringlicher Hinweis, dass etwas zu prüfen ist.
- **Severity:** mittel (Beta manuell-Approval → Anträge versauern sonst).

---

### F5 — Client-Secret ist Pflicht-Startup-Gate, aber funktional Dead Code  [BESTÄTIGT, Verwirrung]
- **Symptom:** `10-check-cloud-creds.sh` macht Hard-Fail ohne `PULSE_CLOUD_CLIENT_ID/_SECRET` →
  Container startet nicht. `07-render-env.sh` exportiert sie. Aber **kein Python-Service liest sie**
  (kein pydantic-config-Feld) — reserviert für „Phase 4–6 cloud-pairing".
- **User-Frage im Test:** „Wofür brauche ich das Secret?" → aktuell: nur damit der Container startet,
  sonst wirkungslos. Verwirrend.
- **Fix-Idee:** Entweder Cloud-Pairing tatsächlich anbinden, ODER das Gate auf „optional/Warnung"
  herabstufen, solange es Dead Code ist. Mindestens in der UI/Docs klarstellen.
- **Auch hier:** `07-render-env.sh` setzt `PULSE_INSTANCE_OWNER_ID` (Z.82), aber **nicht
  `PULSE_INSTANCE_ID`**; `10-check-cloud-creds.sh` prüft `OWNER_ID`, aber nicht `INSTANCE_ID`.
  → bestätigt F2 (chat-gateway crasht ohne INSTANCE_ID, das der Container nie setzt).

### F2 — BLOCKER: Container rendert `PULSE_INSTANCE_ID` nie → chat-gateway crasht  [BESTÄTIGT]
- **Symptom:** `07-render-env.sh` schreibt `/etc/pulse/env.sh` (einzige Env-Quelle der longrun-
  Services, jedes `run` macht `. /etc/pulse/env.sh`). Es rendert OWNER_ID/HOSTNAME/CLIENT_* aus dem
  Docker-Env hinein, **aber keine Zeile `export PULSE_INSTANCE_ID=`**. chat-gateway liest nur env.sh
  → `pulse_instance_id=0` + `mode=self-host` → Hard-Fail `app.py:73`. `-e PULSE_INSTANCE_ID` hilft
  nicht (Services sehen nur env.sh, nicht das rohe Container-Env).
- **Fix:** in `07-render-env.sh` `export PULSE_INSTANCE_ID='${PULSE_INSTANCE_ID}'` ergänzen +
  in `10-check-cloud-creds.sh` als Pflicht-Var prüfen. Ein-Zeiler, aber ohne ihn startet KEINE
  Self-Host-Instanz. **Erfordert Image-Rebuild.**
- **Severity:** kritisch (Total-Blocker für jeden Self-Host).

### F3 — BLOCKER: .env-Snippet aus der Cloud-UI ist mit dem Container inkompatibel  [BESTÄTIGT]
Snippet (`GET /me/instances/{id}/docker-compose-snippet`) liefert live:
```
PULSE_INSTANCE_ID=…            ✅ (aber Container rendert ihn nicht, s. F2)
PULSE_INSTANCE_CLIENT_ID=…     ❌ Container will PULSE_CLOUD_CLIENT_ID
PULSE_INSTANCE_CLIENT_SECRET=… ❌ Container will PULSE_CLOUD_CLIENT_SECRET
PULSE_INSTANCE_MODE / PULSE_CLOUD_ORIGIN  ✅
WORKER_ID_CHAT/VOICE/MEDIA=103/104/105    (s. F4)
```
- **Fehlen im Snippet komplett**, obwohl `10-check-cloud-creds.sh` sie als Pflicht hart verlangt:
  `PULSE_INSTANCE_OWNER_ID` (!! = der Wert der dich zum Admin macht), `PULSE_HOSTNAME`,
  `PULSE_ADMIN_EMAIL`.
- **Folge:** Snippet 1:1 als `.env` → Startup-Check failt sofort (falsche Namen + 3 fehlende
  Pflicht-Vars). Offizieller Onboarding-Pfad gebrochen.
- **Fix:** Snippet-Endpoint (`routes_instance_applications.py`) auf die Var-Namen ausrichten, die der
  Container WIRKLICH liest, und OWNER_ID/HOSTNAME/ADMIN_EMAIL aufnehmen (HOSTNAME/EMAIL als
  ausfüllbare Platzhalter).

### F4 — Vergebene Worker-IDs (103/104/105) werden vom Container ignoriert  [BESTÄTIGT]
- `07-render-env.sh` hardcodet `SNOWFLAKE_WORKER_ID_AUTH/CHAT/VOICE=1/2/3`; `WORKER_ID_*` aus dem
  Snippet wird nirgends verwendet. Für eine isolierte Single-Instanz unkritisch (Pairwise-Sub via
  INSTANCE_ID), aber: dann ist die Worker-ID-Vergabe beim Approval sinnlos / irreführend.
- **Severity:** niedrig (Konsistenz/Aufräumen).

---

### F6 — allinone unbrauchbar hinter bestehendem Reverse-Proxy / auf geteiltem Host  [GEFIXT]
- **Symptom:** Interner Caddy erzwingt 80/443 (TLS + Routing). Auf einem Host mit
  bereits laufendem Proxy (z.B. Hetzner-Host-Caddy für andere Dienste) → Port-
  Konflikt, allinone nicht startbar. `auto`/`provided` terminieren beide TLS im
  Container.
- **Fix:** neuer `PULSE_TLS_MODE=behind-proxy` — interner Caddy macht nur HTTP-
  Routing auf `PULSE_HTTP_PORT` (Default 8080), kein TLS/ACME, keine 80/443. Der
  vorhandene externe Proxy terminiert TLS und braucht nur EINE Regel
  (`pulse.domain → http://<container>:8080`). Routing bleibt komplett im Container.
  `09-init-caddy.sh` (Site-Adresse → `:PORT`, + Fail bei unbekanntem Modus),
  `.env.example` + `docs/SELF_HOST.md` (Caddy- + nginx-Copy-paste), Dockerfile EXPOSE.
- Verifiziert: alle 3 Modi (auto/provided/behind-proxy) + Tippfehler-Fail getestet.
- **Das ist auch der Weg, wie die Test-Instanz auf dem Hetzner laufen wird** (Host-
  Caddy davor).

### F7 — well-known-Routing im allinone-Caddy fehlte  [GEFIXT + live verifiziert]
Nur jwks.json war zu auth-svc geroutet; pulse-server-info (→chat-gateway 8002),
revoked-credentials/version-policy/suspended-instances (→auth 8001) fielen in den
SPA-Fallback (HTML statt JSON) → "Server hinzufügen"-Pre-Check + Poller kaputt.
Fix `Caddyfile.template` (named path-matcher — `handle` nimmt keine Multi-Pfade).

### F8 — Doppelte CORS-Header (Caddy + FastAPI)  [GEFIXT + live verifiziert]
Caddy setzte CORS zusätzlich zu den FastAPI-CORSMiddlewares → 2× ACAO → Browser
verwirft als CORS-Fehler ("Failed to fetch") → Pre-Check/Cert-Login bricht.
Fix: CORS-Block aus `Caddyfile.template` raus (Services machen CORS, wie Cloud-nginx).

### F9 — BLOCKER: Cert-Login-verify crasht (Session-Signing-Key)  [GEFIXT + live verifiziert]
`cert_login.py` liest `SESSION_SIGNING_KEY_FILE` (Default relativ `./data/jwt_keys/...`),
unter s6 (cwd=/opt/pulse/services/chat-gateway) nicht beschreibbar → PermissionError →
500 ohne CORS-Header → im Browser als CORS-Fehler maskiert. `07-render-env.sh` setzte
nur die toten Namen `PULSE_SESSION_TOKEN_PRIVATE/_PUBLIC`. Fix: `SESSION_SIGNING_KEY_FILE
=/data/jwt_keys/session_signing.pem` rendern. **Damit läuft der Cert-Login E2E durch.**

### F10 — weitere relative Upload-Pfade  [GEFIXT + live verifiziert]
`guild_icon_upload_dir` + `avatar_upload_dir` waren relativ → Upload-Crash wie F9.
`07-render-env.sh` setzt jetzt AVATAR_UPLOAD_DIR + GUILD_ICON_UPLOAD_DIR auf
/data/uploads/* (Dirs legt 01-init-data-dirs bereits an). In env.sh verifiziert.

### F11 — Admin-Panel mischt Cloud- und Self-Host-Endpoints  [OFFEN, Design-Entscheidung]
Auf der aktiven Self-Host-Instanz laden einige Admin-Bereiche ihre Daten von der
CLOUD-auth statt von der Instanz: `howispulse.com/api/auth/admin/{stats,settings,smtp,
backup-status,users,audit-log}` → 403 (dev ist kein Cloud-Admin). Die chat-gateway-
Bereiche (`/api/chat/admin/*`: permissions, plugins, dm-limits, stats, audit) gehen
korrekt an die Instanz (200, session_token-admin-Claim akzeptiert).
Kern: Cert-Login-Admins haben kein auth-svc-Token für die Instanz-auth. Offene Fragen:
welche auth-svc-Admin-Funktionen sind auf Self-Host überhaupt sinnvoll, und wie
authentifiziert man sie (session_token an Instanz-auth-svc statt Cloud)? Braucht Design.

## Test-Durchlauf 2 (2026-06-03) — Onboarding + Cert-Login FUNKTIONIERT
Antrag (dev) → Approval (oblivion, Badge ✓) → allinone behind-proxy auf Hetzner
hinter Host-Caddy → Pre-Check ✓ → Cert-Login challenge+verify ✓ → Instanz eingebunden,
verbunden, dev als Admin erkannt (Panel lädt, chat-gateway-Admin 200). Offen: F10, F11, Voice/HQ.

### F13 — Voice-Media-Infra nicht für externe Clients konfiguriert  [GEFIXT + live verifiziert]
Fix: `infra/self-host/templates/livekit.yaml.template` angelegt (rtc.use_external_ip:true)
→ LiveKit meldet jetzt `nodeIP: 77.42.71.166` (öffentliche IP) + `using external IPs`
statt der internen 10.x. coturn `external-ip` via PULSE_PUBLIC_IP/Autodetect
(`external-ip=77.42.71.166`). Damit zeigen ICE-Kandidaten nach außen — echte Calls
von außen sind möglich. (Voller 2-Client-Call/HQ = manueller Desktop-Test.)
Ursprünglich (Befund):
Voice-Infra geprüft (kein 2-Client-Call, auf Wunsch): LiveKit + coturn laufen, aber:
- **`livekit.yaml.template` fehlt komplett** → 05-init-livekit nutzt die Minimal-
  Fallback-Config (loggt "Phase 6.B not applied"), OHNE `rtc.use_external_ip`/`node_ip`.
  LiveKit meldet `nodeIP: 10.0.4.2` (interne Docker-IP) → ICE-Kandidaten zeigen ins
  Docker-Netz, externe Clients bekommen keine Media-Verbindung.
- **coturn** (04-init-coturn.sh) rendert die turnserver.conf ohne `external-ip`;
  `PULSE_PUBLIC_IP` wird nur im Kommentar erwähnt, nirgends real verdrahtet.
- `PULSE_HTTP`/Signaling (Caddy /livekit WS, /api/voice) ist erreichbar — nur der
  Media-Plane (UDP/ICE/TURN) ist unkonfiguriert.
- **Fix-Paket:** livekit.yaml.template anlegen (use_external_ip:true ODER node_ip aus
  PULSE_PUBLIC_IP) + ins Image kopieren; coturn external-ip aus PULSE_PUBLIC_IP setzen;
  PULSE_PUBLIC_IP in .env.example + Auto-Detect. Substanzielles eigenes Paket.
- **HQ-Streaming** ist Electron-Desktop-only (GSR-Sidecar) → per Browser/CDP gar nicht testbar.

## Test-Durchlauf 1 (2026-06-03)
- Cloud-Admin `oblivion` approved Antrag von `dev` für `pulse.unicutmedia.com`.
- Werte (instance_id/client_id/owner_id/secret) liegen beim Tester, nicht im Repo.
- Durchlauf 2 nach Image-Rebuild + Cloud-Deploy der Fixes ausstehend.

## F19 — Self-Host-Member-Namen (Voice-Kachel + Member-Liste zeigen `user-<id>` / `…`)
Beobachtet 2026-06-03: auf `pulse.unicutmedia.com` zeigt die Voice-Kachel `user-1645520347282241315`
und die Member-Liste `…` statt „dev". Voice selbst verbindet (F17 ok), keine Konsolen-Fehler.

Root-Cause (3 gestapelte Lücken):
1. **Cloud-Auth** stellt das Profile-Statement mit `display_name: null` aus (dev hat keinen gesetzt)
   → Self-Host-Validator (`user_profile_cache.upsert_profile_statement`, verlangt display_name) verwirft es
   → kein `CachedUserProfile`.
2. **Frontend** löst alle Namen über `GET /users` mit hartem `endpoint:'auth'` (Cloud) auf — die Cloud
   kennt die Self-Host-pairwise/Synth-IDs nicht → Fallback `…` / rohe `user-<id>`.
3. **Keine Brücke** numerische Synth-ID (`synthesize_self_host_user_id(pairwise)`, in GuildMember/LiveKit)
   ↔ `CachedUserProfile` (key = base62-pairwise) → selbst ein korrekter Self-Host-Lookup fände nichts.

Fix (implementiert, Commit s.u.):
- **L1 Cloud-Auth** `routes_profile._issue_statement`: `display_name = user.display_name or username`.
- **L2 chat-gateway**: `CachedUserProfile.synthetic_user_id` (Spalte + Index, Migration `0031`), im Upsert
  befüllt; neuer `GET /users?ids=…` löst numerische IDs → UserSummary auf.
- **L3 Frontend** `userCache`: auf Self-Host `endpoint:'chat'` (Self-Host /users) statt Cloud, mit
  Cloud-Fallback für unaufgelöste IDs (DM-/Friends-Namen bleiben heil); `VoiceParticipantTile` bevorzugt
  den aufgelösten Namen vor der rohen LiveKit-Identity.
- Tests: `test_users_resolve.py` (5) + `synthetic_user_id`-Population in `test_profile_cache.py`.
- Deploy: Cloud (auth+web+chat, Migration `migrate-chat` 0031) **und** Hetzner-allinone (Rebuild + Redeploy).
