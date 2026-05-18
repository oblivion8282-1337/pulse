"""Service configuration."""

from __future__ import annotations

from functools import lru_cache

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
    vapid_private_key: str | None = None
    vapid_public_key: str | None = None
    vapid_subject: str = "mailto:admin@example.com"
    vapid_key_file: str = "./data/vapid.json"

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
