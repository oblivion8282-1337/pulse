"""Service configuration loaded from environment variables."""

from __future__ import annotations

import re
from functools import lru_cache
from pathlib import Path
from typing import Literal

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

_RATE_RE = re.compile(r"^\d+/(second|minute|hour)s?$")


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=None,  # uvicorn/CLI loads .env if needed; tests inject env directly.
        extra="ignore",
    )

    # Database
    postgres_user: str = "dcc"
    postgres_password: str = ""
    postgres_db: str = "dcc"
    postgres_host: str = "localhost"
    postgres_port: int = 5434
    database_url: str | None = None
    database_schema: str = "auth"

    # JWT
    jwt_private_key_file: Path = Path("./secrets/jwt_private.pem")
    jwt_public_key_file: Path = Path("./secrets/jwt_public.pem")
    jwt_issuer: str = "dcc-auth"
    jwt_audience: str = "dcc"
    jwt_access_ttl_seconds: int = 900
    jwt_refresh_ttl_seconds: int = 60 * 60 * 24 * 30
    jwt_key_id: str = "auth-1"
    # Public OIDC issuer used for Identity-Certs (DE 11). Deliberately distinct
    # from jwt_issuer so the chat-gateway's cert validator can tell a cert apart
    # from an access token by `iss`. MUST equal chat-gateway's PULSE_OIDC_ISSUER
    # (same default here and there); on self-host the cert is Cloud-signed, so
    # the Cloud's value is what the self-host gateway validates against.
    pulse_oidc_issuer: str = "https://howispulse.com"

    # Instance role. Only the Cloud (``cloud``) may approve/suspend Self-Host
    # instances; every other deployment defaults to ``self-host`` and is locked
    # out of those admin routes. Mirrors chat-gateway's PULSE_INSTANCE_MODE —
    # the prod .env sets it to ``cloud`` on howispulse.com.
    pulse_instance_mode: Literal["cloud", "self-host"] = "self-host"

    # Mandatory-SSO default: on a self-host instance, local password
    # registration is OFF — users sign in with their howispulse.com identity
    # (cert-login). A self-hoster who wants a sealed, cloud-independent island
    # sets ALLOW_LOCAL_ACCOUNTS=true. Irrelevant on the Cloud, which is *the*
    # identity source and always accepts registration (subject to
    # registration_mode open/invite/closed).
    allow_local_accounts: bool = False

    # Snowflakes
    snowflake_worker_id_auth: int = Field(default=1, ge=0, le=1023)

    # CORS
    cors_allow_origins: str = "http://localhost:5173,http://127.0.0.1:5173"

    # Avatar upload
    avatar_upload_dir: str = "./uploads/avatars"

    # Backup status — the backup sidecar (infra/prod/backup/) writes an
    # ISO-8601 timestamp to ``.pulse/last-backup-ok`` in the ``pulse_backups``
    # volume after every successful run. We mount that volume read-only at
    # ``/backup-state`` in prod so the admin endpoint can stat the marker
    # file. ``configured=False`` is the natural state outside prod — the
    # path simply won't exist.
    backup_marker_path: Path = Path("/backup-state/.pulse/last-backup-ok")
    # Stale threshold (seconds). Matches the compose healthcheck on the
    # ``backup`` service — 36 h = 24 h daily cycle + 12 h slack.
    backup_stale_threshold_seconds: int = 129_600

    # Rate limiting
    rate_limit_register: str = "5/minute"
    rate_limit_login: str = "20/minute"
    rate_limit_password_forgot: str = "2/minute"
    rate_limit_password_reset: str = "10/minute"
    rate_limit_email_verify_send: str = "2/minute"
    rate_limit_login_totp: str = "20/minute"
    rate_limit_totp_verify_setup: str = "10/minute"
    rate_limit_totp_setup: str = "10/minute"
    rate_limit_totp_disable: str = "10/minute"
    rate_limit_totp_backup_regenerate: str = "10/minute"
    # Self-Host One-Command-Installer: Mint ist owner-cookie-gated (locker),
    # Redeem ist token-gated + öffentlich (eng). TTL = Lebensdauer des
    # One-Time-Bootstrap-Tokens.
    rate_limit_bootstrap_mint: str = "20/minute"
    rate_limit_bootstrap_redeem: str = "10/minute"
    bootstrap_token_ttl_seconds: int = 1200
    # WebAuthn ceremonies. ``register`` covers the authenticated add-a-passkey
    # flow; ``login`` covers both the 2FA-second-step and the passwordless
    # entry point (the latter is unauthenticated, so keep it as tight as the
    # password ``/login`` bucket).
    rate_limit_webauthn_register: str = "10/minute"
    rate_limit_webauthn_login: str = "20/minute"
    # Account self-delete is irreversible and Hard-Delete on the chat side
    # (messages purged too). Keep the bucket *very* tight — a stolen access
    # token shouldn't be able to nuke an account before the user notices.
    rate_limit_account_delete: str = "3/hour"
    # User-search (``GET /users/search``). 30/min/user is generous enough
    # for autocomplete-style "type-then-fetch" UIs but blocks bulk
    # username enumeration. The endpoint is also gated by
    # ``users.discoverable`` (opt-out) so the limit is the second line of
    # defence, not the first.
    rate_limit_user_search: str = "30/minute"

    # Redis -- optional for CRL (auth:revoked_certs ZSET)
    redis_url: str = "redis://localhost:6380/0"

    # Cross-service: auth → chat-gateway. ``DELETE /me`` calls
    # ``POST {chat_gateway_url}/internal/users/{id}/purge`` to hard-delete the
    # user's chat-side state (memberships, messages, presence) BEFORE the
    # auth-side row is removed. The secret matches the one chat-gateway sees
    # in its own ``INTERNAL_SERVICE_SECRET`` env (single source of truth on
    # the operator side). Leaving it ``None`` here DISABLES self-delete — the
    # route 503s with an explicit operator-hint message rather than silently
    # deleting auth-side and orphaning chat-side rows.
    internal_service_secret: str | None = None
    chat_gateway_url: str = "http://chat-gateway:8000"
    # ``DELETE /me`` blocks on the chat-gateway purge — message-hard-delete on
    # a chatty user can be slow. 30 s is generous compared to the 5 s used
    # for voice-evict; if your deployment's purge takes longer you have a
    # bigger problem.
    chat_gateway_purge_timeout_s: float = 30.0

    # Account-recovery / 2FA
    smtp_host: str | None = None
    smtp_port: int = 587
    smtp_user: str | None = None
    smtp_password: str | None = None
    smtp_from: str = "noreply@pulse.local"
    smtp_use_ssl: bool = False  # True ≈ port 465; False ≈ port 587 STARTTLS
    password_reset_ttl_seconds: int = 3600  # 1h
    email_verification_ttl_seconds: int = 86400  # 24h
    mfa_ticket_ttl_seconds: int = 300  # 5min — short-lived MFA login challenge
    # Background cleanup of stale token rows. ``_run_once`` (in ``cleanup.py``)
    # fires every ``token_cleanup_interval_seconds`` and deletes:
    #   * ``password_reset_tokens`` / ``email_verification_tokens`` whose
    #     ``expires_at`` is older than ``…_grace_days_expired`` (default 7 d —
    #     grace is intentional so an operator can still introspect a recent
    #     reset attempt during incident debugging),
    #   * ``refresh_tokens`` with non-null ``revoked_at`` older than
    #     ``…_grace_days_revoked`` (default 30 d).
    # Backup codes are *never* swept here — they're 2FA audit-trail and
    # cascade out when the user disables 2FA.
    token_cleanup_interval_seconds: int = 86400  # 24h
    token_cleanup_grace_days_expired: int = 7
    token_cleanup_grace_days_revoked: int = 30
    # Self-hoster overrides in prod (e.g. ``https://pulse.example.com``); used
    # for the reset/verify links embedded in outbound emails.
    app_base_url: str = "http://localhost:5173"
    totp_issuer: str = "Pulse"

    # --- WebAuthn / passkeys ------------------------------------------------
    # The Relying Party id MUST be a registrable domain suffix of every origin
    # the ceremony runs on. Dev default is ``localhost`` — note that means dev
    # browsers have to reach the app via ``http://localhost:5173`` and NOT
    # ``http://127.0.0.1:5173`` (an IP literal can't be an rpId, so a passkey
    # created on one host won't validate on the other). In prod set it to the
    # bare apex, e.g. ``howispulse.com``.
    webauthn_rp_id: str = "localhost"
    # Human-readable name shown by the authenticator's consent UI.
    webauthn_rp_name: str = "Pulse"
    # CSV of allowed ceremony origins. Dev = the Vite origin; prod =
    # ``https://howispulse.com``. The Electron app loads that same
    # remote origin, so it needs no separate entry.
    webauthn_origin: str = "http://localhost:5173"
    # TTL of the signed challenge ticket bridging the options→verify steps.
    # 5 min mirrors ``mfa_ticket_ttl_seconds`` — long enough for a Touch-ID
    # prompt, short enough that a leaked ticket is near-useless.
    webauthn_challenge_ttl_seconds: int = 300
    # IPs / CIDRs whose ``X-Forwarded-For`` header we trust. Anything else and
    # the rate-limiter falls back to the peer address — a malicious client
    # cannot then spoof its bucket. **Default is loopback only**: in the Pulse
    # production deployment the auth service sits behind pulse_web (nginx) on
    # the pulse-net bridge, and the operator MUST set ``TRUSTED_PROXIES`` to
    # the concrete pulse_web container IP (or its /32). Defaulting to the
    # whole 172.16/12 + 10/8 would let any container on the host's docker
    # bridge spoof XFF and bypass the rate limit entirely.
    trusted_proxies: str = "127.0.0.1,::1"

    @field_validator(
        "rate_limit_register",
        "rate_limit_login",
        "rate_limit_password_forgot",
        "rate_limit_password_reset",
        "rate_limit_email_verify_send",
        "rate_limit_login_totp",
        "rate_limit_totp_verify_setup",
        "rate_limit_totp_setup",
        "rate_limit_totp_disable",
        "rate_limit_totp_backup_regenerate",
        "rate_limit_webauthn_register",
        "rate_limit_webauthn_login",
        "rate_limit_account_delete",
        "rate_limit_user_search",
        "rate_limit_bootstrap_mint",
        "rate_limit_bootstrap_redeem",
    )
    @classmethod
    def _validate_rate_format(cls, v: str) -> str:
        if not _RATE_RE.match(v):
            raise ValueError(
                f"rate limit {v!r} must match '<N>/<period>' "
                "(e.g. '5/minute', '20/seconds', '1/hour')"
            )
        return v

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
    def webauthn_origins_list(self) -> list[str]:
        return [o.strip() for o in self.webauthn_origin.split(",") if o.strip()]

    def load_private_key(self) -> str:
        return self.jwt_private_key_file.read_text()

    def load_public_key(self) -> str:
        return self.jwt_public_key_file.read_text()


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()
