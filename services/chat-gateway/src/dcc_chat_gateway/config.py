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
    s3_presigned_ttl_seconds: int = 1800  # 30 min, auto-refreshed client-side

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

    # How long a cached profile is considered fresh before being marked
    # ``stale`` (seconds).  After the TTL the profile is still served but
    # flagged stale; a fresh profile statement replaces it on next login.
    profile_cache_ttl_seconds: int = 24 * 3600  # 24 h

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

    # Cloud user-id of this instance's owner (the applicant who registered it).
    # The Cloud hands this out at approval. At cert-login, the user whose cert
    # carries this user_id becomes admin of this instance. 0 = nobody (no
    # auto-admin; e.g. the Cloud itself, where admin comes from auth.users).
    pulse_instance_owner_id: int = 0

    # Cloud origin used for JWKS + CRL polling.  Self-hosts may point this at
    # a mirror or internal proxy if they can't reach howispulse.com directly.
    pulse_cloud_origin: str = "https://howispulse.com"

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


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()
