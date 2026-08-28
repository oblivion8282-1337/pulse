"""Service configuration."""

from __future__ import annotations

from functools import lru_cache
from typing import Literal

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=None, extra="ignore")

    postgres_user: str = "dcc"
    postgres_password: str = ""
    postgres_db: str = "dcc"
    postgres_host: str = "localhost"
    postgres_port: int = 5434
    database_url: str | None = None
    database_schema: str = "chat"

    redis_url: str = "redis://localhost:6380/0"

    auth_jwks_url: str = "http://localhost:8001/.well-known/jwks.json"
    jwt_audience: str = "dcc"
    jwt_issuer: str = "dcc-auth"
    jwks_cache_seconds: int = 3600

    # media-svc — issues per-channel HQ-stream publish tokens and exposes the
    # WHEP playback URL. chat-gateway is the membership-gated proxy in front of
    # it (T5b): it checks the user is a member of the channel's guild, then
    # forwards the user's access token to media-svc.
    media_svc_url: str = "http://127.0.0.1:8004"
    media_svc_timeout_s: float = 10.0

    # voice-signaling internal-evict callback. chat-gateway hits this
    # endpoint on kick/ban so voice-signaling can yank the target from
    # LiveKit + clear voice-overrides for every voice channel in the
    # guild. Empty secret DISABLES the call — fail-open here (kick/ban
    # still works, just leaves the LiveKit session live); set both
    # ``voice_signaling_url`` and ``internal_service_secret`` together.
    voice_signaling_url: str = "http://127.0.0.1:8003"
    voice_signaling_timeout_s: float = 3.0
    internal_service_secret: str = ""

    # auth-svc base URL — used by the privacy route to mirror
    # ``show_in_search`` flips over to ``auth.users.discoverable``. The
    # call uses ``internal_service_secret`` for auth (single shared secret
    # across all service-to-service traffic). Failure to reach auth-svc
    # is logged + swallowed: chat-gateway has already committed the user
    # privacy row, the auth side will be reconciled on the next flip or
    # by a manual operator nudge.
    auth_svc_url: str = "http://127.0.0.1:8001"
    auth_svc_timeout_s: float = 3.0

    snowflake_worker_id_chat: int = Field(default=2, ge=0, le=1023)

    # Guild-icon uploads (owner-only). Resized to 256px webp, served via
    # /api/chat/guild-icons/<guild_id>.webp (cache-buster ?v=… in icon_url).
    guild_icon_upload_dir: str = "./uploads/guild-icons"

    # MinIO (S3-compatible) for message attachments. The split between
    # *internal* and *public* endpoints matters in prod: server-side ops
    # (delete, head, bucket admin) use the internal docker-DNS URL; presigned
    # URLs handed to the browser use the public one (nginx /s3/* → MinIO).
    # In dev both are the same localhost URL.
    s3_internal_endpoint: str = "http://localhost:9000"
    s3_public_endpoint: str = "http://localhost:9000"
    s3_region: str = "us-east-1"
    s3_bucket: str = "pulse-attachments"
    s3_access_key: str = "minioadmin"
    s3_secret_key: str = "minioadmin"
    s3_presigned_ttl_seconds: int = 600  # 10 min, PUT and GET alike.
    # Lowered from 30 min so a leaked PUT URL shrinks the orphan-
    # upload DoS window. The orphan sweep on the trash cadence
    # cleans up after the TTL anyway; clients mint fresh URLs on
    # retry which still works inside the 10 min.

    cors_allow_origins: str = "http://localhost:5173,http://127.0.0.1:5173"

    # ------------------------------------------------------------------ #
    # Phase 3 — Self-Host / OIDC / Moderation settings                  #
    # ------------------------------------------------------------------ #

    # OIDC issuer used in Cert-JWT validation (``iss`` claim must match).
    # Self-hosts can override if they mirror the Cloud auth-svc behind a
    # local proxy.
    pulse_oidc_issuer: str = "https://howispulse.com"

    # JWT audience expected in *Cert-JWTs* (credential_validator). Certs
    # carry the Cloud's JWT_AUDIENCE ("dcc"). ``None`` ⇒ Cloud mode falls
    # back to the local ``jwt_audience`` (validates its own certs, values
    # agree by construction); self-host skips the check unless this is set
    # (its local ``jwt_audience`` is "pulse-self-host", NOT the cert value —
    # the all-in-one image sets PULSE_JWT_AUDIENCE=dcc explicitly).
    # Note: the separate ``jwt_audience`` field governs chat-gateway's own
    # Access-JWT validation.
    pulse_jwt_audience: str | None = None

    # Moderation tools — core feature, cannot be disabled.  Flag reserved
    # for future granular mod-tools opt-out (e.g. report-submission only
    # vs. full mod queue).
    mod_tools_enabled: bool = True

    # Path to the JWKS-pin file (SHA-256 of sorted kid list).  Written on
    # first successful JWKS pull; checked on every subsequent pull.
    # Operator rotates by deleting the file or calling the admin endpoint.
    jwks_pin_file: str = "/data/jwks-pin.txt"

    # How often the Cloud policy document is polled (seconds).
    # 6 h matches the recommended max-age from DE 12.
    cloud_policy_poll_interval: int = 6 * 3600  # 6 h

    # IPs / CIDRs whose ``X-Forwarded-For`` wir für das per-IP-Rate-Limiting
    # (cert-login) vertrauen — Spiegel von auth-svc ``trusted_proxies``.
    # Hinter Caddy/nginx ist die Socket-IP IMMER die Proxy-IP: ohne XFF teilen
    # sich alle Nutzer einen Bucket (gegenseitiges Aussperren möglich) und ein
    # einzelner Angreifer ist faktisch ungedrosselt. Default loopback-only:
    # deckt den All-in-one-Self-Host ab (Caddy im selben Container); die Cloud
    # setzt TRUSTED_PROXIES in der .env auf das pulse-net (siehe .env.example).
    # Von nicht gelisteten Peers wird XFF ignoriert (Spoofing-Schutz).
    trusted_proxies: str = "127.0.0.1,::1"

    # Self-Host identity model (DE 11 / DE 14)
    # ``cloud``   — Cloud instance; user_id used directly as identifier.
    # ``self-host`` — Self-hosted instance; pairwise-sub replaces user_id.
    # Default is ``self-host`` so a single-container deployment is safe out of
    # the box; the Cloud sets ``PULSE_INSTANCE_MODE=cloud`` explicitly.
    pulse_instance_mode: Literal["cloud", "self-host"] = "self-host"

    # Snowflake-ID assigned by the Cloud on Self-Host registration.
    # Reserved value 0 = Cloud instance (DE 11 A.13).
    pulse_instance_id: int = 0

    # ─── Cloud upload hardening ──────────────────────────────────────────
    # The Cloud deliberately narrows its upload surface to what hash-matching
    # (Arachnid Shield) can actually see: images. Videos, archives and
    # ``application/octet-stream`` are invisible to a hash lookup, so an upload
    # surface wider than the scanner is exactly the path an abuser would take.
    # Rationale + legal background: docs/medien-speicher-und-scanning.md.
    #
    # All three flags apply ONLY when ``pulse_instance_mode == "cloud"``.
    # Self-hosted instances are untouched by design: under the cert model they
    # are isolated worlds whose operator answers for their own content, and we
    # have no access to it.
    #
    # Defaults are restrictive so a fresh Cloud deploy is hardened without any
    # .env change (same spirit as ``allow_guild_creation`` defaulting to false).
    # Local dev + E2E re-enable them via scripts/dev-up.fish so the features
    # stay exercised. To re-arm in production, set the env var — no code change:
    #   CLOUD_DM_ATTACHMENTS_ENABLED=true
    #   CLOUD_DROPBOX_ENABLED=true
    #   CLOUD_ATTACHMENT_MIME_PREFIXES=          (empty = no extra restriction)
    cloud_dm_attachments_enabled: bool = False
    cloud_dropbox_enabled: bool = False
    # CSV of allowed MIME prefixes on top of the base allowlist in
    # routes/attachments.py. Empty string = no extra restriction.
    cloud_attachment_mime_prefixes: str = "image/"

    # Cloud user-id of this instance's owner (the applicant who registered it).
    # The Cloud hands this out at approval. At cert-login, the user whose cert
    # carries this user_id becomes admin of this instance. 0 = nobody (no
    # auto-admin; e.g. the Cloud itself, where admin comes from auth.users).
    pulse_instance_owner_id: int = 0

    # Cloud origin used for JWKS + CRL polling.  Self-hosts may point this at
    # a mirror or internal proxy if they can't reach howispulse.com directly.
    pulse_cloud_origin: str = "https://howispulse.com"

    # Public web-app origin (this instance's own). Used to build user-facing
    # links inside messages — e.g. the rejoin invite in the unban DM, which the
    # client renders as a join card. Shared ``APP_BASE_URL`` env with auth-svc's
    # email links; prod sets it to the real origin, dev keeps the Vite origin.
    app_base_url: str = "http://localhost:5173"

    # Path for the locally-generated Ed25519 session-signing key (DE 9).
    session_signing_key_file: str = "./data/jwt_keys/session_signing.pem"

    # HMAC secret used to sign the short-lived challenge-tokens issued by
    # ``POST /cert-login/challenge`` (Phase 5.1). The secret is base64url-
    # encoded; empty means "generate ephemeral secret on first use and
    # WARN".  Set ``CHAT_GATEWAY_CHALLENGE_SECRET`` in ``.env`` to a stable
    # value (>=32 raw bytes) to keep tokens valid across restarts; for
    # single-pod self-host deployments the ephemeral default is fine, but
    # in-flight challenge-tokens will be invalidated on restart.
    chat_gateway_challenge_secret: str = ""

    # Web-Push VAPID — used to sign the Push API requests we send to a user's
    # browser push service (FCM/Mozilla/etc.). The *private* key is PEM-encoded
    # EC P-256 and stays server-side; the *public* key is the base64url-encoded
    # raw P-256 point the browser passes to ``pushManager.subscribe``.
    # ``vapid_subject`` MUST be a ``mailto:`` URI or an https URL (RFC 8292) —
    # push services reject malformed subjects.
    # When ``vapid_private_key`` is empty, ``push.ensure_vapid`` auto-generates
    # a keypair on first startup and persists it to ``vapid_key_file`` so
    # subsequent restarts use the same key. Self-hosters can pre-provision
    # both keys via env vars to skip the auto-gen + avoid the on-disk file.
    # ``vapid_private_key`` accepts a raw PKCS#8 PEM or its base64 encoding
    # (the env_file-safe single-line form — see ``vapid._resolve_private_pem``).
    vapid_private_key: str | None = None
    vapid_public_key: str | None = None
    vapid_subject: str = "mailto:admin@example.com"
    vapid_key_file: str = "./data/vapid.json"

    # Background cleanup of long-idle Web-Push subscriptions. ``push.py``
    # already drops a sub when the provider returns 404/410; this catches
    # the case where the endpoint still answers 2xx but belongs to a
    # browser the user never opens. See ``cleanup.py`` for the delete
    # predicate (created_at + last_used_at both older than N days).
    push_subscription_idle_days: int = 60
    cleanup_interval_seconds: int = 86400  # 24 h

    # Voice-pull reaper — backstop that revokes grants the participant_left
    # webhook missed (network blip) or that the target never connected to.
    # The webhook path is authoritative; this only sweeps grants whose
    # target is confirmed-absent (Redis) AND older than the grace window.
    voice_pull_reaper_interval_seconds: int = 60
    voice_pull_reaper_grace_seconds: int = 300

    # Postfach (Etappe D, E2E-DM) — Grenzen fuer verschluesselte Zustellung.
    # Vorbild ``push_subscription_idle_days`` oben. Eine Zustellung ohne
    # Frist waere eine, die nie wegginge (s. ``models/postfach.py``); die
    # Route setzt ``verfaellt_am`` bei jeder Einlieferung aus dieser Zahl.
    postfach_frist_tage: int = 30
    # Ein Umschlag traegt Olm-/Megolm-Chiffretext plus etwas JSON-Overhead —
    # ein normaler Text bleibt weit darunter. Anhaenge fliessen ueber S3
    # (nur der Dateischluessel reist im Umschlag mit, s. Spec §5), deshalb
    # muss der Umschlag selbst nicht gross sein. Ohne Obergrenze waere das
    # Postfach ein kostenloser, unpruefbarer Dateispeicher.
    postfach_max_umschlag_bytes: int = 256 * 1024
    # Obergrenze der Umschlaege je Einliefer-Anfrage — ein Vielfaches der
    # groessten heute denkbaren Fan-out-Menge, ohne eine einzelne Anfrage
    # beliebig aufblasen zu lassen.
    postfach_max_nutzlasten_je_anfrage: int = 100
    # Offene (noch nicht quittierte) Zustellungen je Empfaengergeraet. Ein
    # Geraet, das nie abholt, darf den Server nicht unbegrenzt fuellen —
    # weitere Einlieferungen an EIN so volles Geraet werden uebersprungen
    # (wie ein unbekanntes Geraet), nicht die ganze Anfrage abgewiesen.
    postfach_max_offene_zustellungen_je_geraet: int = 500
    # Offene Zustellungen je (Absender-Geraet, Empfaengergeraet) — Bughunt
    # 2026-08-28 (Missbrauch), FIX 3. Ohne diese zweite, engere Grenze zaehlt
    # die obige Obergrenze ueber ALLE Absender hinweg: ein einzelner
    # akzeptierter Kontakt kann sie mit ein paar Anfragen alleine fuellen
    # (256 KiB je Umschlag, ~62 je 16-MB-Anfragekoerper), danach werden
    # Zustellungen JEDES ANDEREN Freundes an dieses Geraet stillschweigend
    # uebersprungen, bis die 30-Tage-Frist der aeltesten ablaeuft. 50 ist
    # bewusst ein Zehntel der Gesamtgrenze: ein Geraet mit 10 aktiven
    # Korrespondenten kann sein Kontingent dann rechnerisch ausschoepfen,
    # ohne dass irgendein einzelner mehr als sein Zehntel beansprucht — kein
    # gemessener Wert, sondern aus der Gesamtgrenze abgeleitet, damit beide
    # Zahlen zueinander passen.
    postfach_max_offene_zustellungen_je_absender_und_geraet: int = 50

    # Private Gruppen (Etappe G1) — Vorgabe AUS, am Vorbild von
    # ``cloud_dm_attachments_enabled`` oben. Grund: die Kanalart wird HIER
    # gebaut, aber die Krypto (Megolm, Etappe G2) kommt erst spaeter — private
    # Gruppen sollen von Geburt an verschluesselt sein, ohne Altbestand und
    # ohne Umschaltmoment (Spec §9). Solange der Schalter aus ist, kann
    # ``POST /gruppen`` keine Zeile anlegen; die Oberflaeche zeigt die
    # Kanalart ohnehin nicht (kein UI in dieser Etappe). Reversibel per
    # ``PRIVATE_GROUPS_ENABLED=true`` — gedacht fuer G2, nicht fuer diese
    # Etappe.
    private_groups_enabled: bool = False
    # Obergrenze der Mitgliederzahl. In G2 wird der Gruppenschluessel an JEDES
    # Geraet JEDES Mitglieds verteilt — ohne Obergrenze waere eine einzelne
    # Mitgliedschaftsaenderung in einer grossen Gruppe ein Schwall kleiner
    # Schluesselumschlaege. 50 ist grosszuegig fuer eine private Gruppe und
    # bewusst kein Politikwert, den ein Betreiber je Instanz hochdrehen
    # sollte, ohne die G2-Verteil-Kosten neu abzuschaetzen.
    private_group_max_members: int = 50

    # Geraete-Schluesselverzeichnis (Etappe B, E2E-DM) — Bughunt 2026-08-28
    # (Missbrauch), FIX 1. Obergrenze der gleichzeitig gespeicherten Buendel
    # je Konto. Auth-svc laesst bis zu 20 gleichzeitig gueltige Zertifikate
    # je Konto zu (rollierendes Fenster, ``routes_credentials.py``) — das
    # ist die tatsaechliche Zahl legitimer Geraete zu jedem Zeitpunkt. Ein
    # Buendel haengt bewusst an ``device_pubkey``, nicht an ``cert_id`` (s.
    # ``models/geraete_schluessel.py``): ein Geraet, das seinen
    # Signierschluessel wechselt (Neuinstallation, verlorenes Geraet),
    # hinterliesse sonst eine Buendelzeile plus bis zu ``ONE_TIME_KEY_CAP``
    # Einmalschluessel fuer immer — nur eine vollstaendige Kontoloeschung
    # raeumte sie weg. Dieselbe Zahl wie der Cert-Cap, nicht groesser: mehr
    # als 20 gleichzeitig gueltige Zertifikate kann ein Konto ohnehin nicht
    # haben.
    schluessel_max_buendel_je_konto: int = 20
    # Bughunt 2026-08-28 (Missbrauch), FIX 2. Budget verbrauchter
    # Einmalschluessel je (Absender, Ziel) und Zeitfenster — sonst leert
    # ~100 billige ``POST /keys/claim``-Aufrufe den gesamten Vorrat eines
    # Kontakts, und JEDER Absender faellt danach auf den wiederverwendeten
    # Rueckfallschluessel (keine Forward Secrecy je Sitzung) zurueck. 30
    # liegt knapp ueber ``schluessel_max_buendel_je_konto`` (20): ein
    # legitimer Erstkontakt mit einem Ziel, das alle 20 moeglichen Geraete
    # gleichzeitig betreibt, verbraucht in einem einzigen ``claim``-Aufruf
    # bis zu 20 Einmalschluessel (einen je Geraet) — das Budget muss das in
    # EINEM Fenster tragen, ohne einem Angreifer viel Spielraum darueber
    # hinaus zu lassen.
    schluessel_claim_budget_je_ziel: int = 30
    schluessel_claim_fenster_sekunden: int = 3600  # 1 h.

    @property
    def effective_database_url(self) -> str:
        if self.database_url:
            return self.database_url
        return (
            f"postgresql+asyncpg://{self.postgres_user}:{self.postgres_password}"
            f"@{self.postgres_host}:{self.postgres_port}/{self.postgres_db}"
        )

    @property
    def cors_origins_list(self) -> list[str]:
        return [o.strip() for o in self.cors_allow_origins.split(",") if o.strip()]

    @property
    def cloud_attachment_mime_prefix_list(self) -> list[str]:
        """Extra MIME-prefix allowlist for Cloud uploads; empty = unrestricted.

        Only meaningful when ``pulse_instance_mode == "cloud"`` — callers gate
        on that first (see routes/attachments.py::_validate_mime)."""
        return [p.strip() for p in self.cloud_attachment_mime_prefixes.split(",") if p.strip()]


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()
