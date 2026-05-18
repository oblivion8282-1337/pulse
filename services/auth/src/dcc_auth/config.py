"""Service configuration loaded from environment variables."""

from __future__ import annotations

import re
from functools import lru_cache
from pathlib import Path

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

    # Snowflakes
    snowflake_worker_id_auth: int = Field(default=1, ge=0, le=1023)

    # CORS
    cors_allow_origins: str = "http://localhost:5173,http://127.0.0.1:5173"

    # Avatar upload
    avatar_upload_dir: str = "./uploads/avatars"

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
    # Account self-delete is irreversible and Hard-Delete on the chat side
    # (messages purged too). Keep the bucket *very* tight — a stolen access
    # token shouldn't be able to nuke an account before the user notices.
    rate_limit_account_delete: str = "3/hour"

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
        "rate_limit_account_delete",
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

    def load_private_key(self) -> str:
        return self.jwt_private_key_file.read_text()

    def load_public_key(self) -> str:
        return self.jwt_public_key_file.read_text()


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()
