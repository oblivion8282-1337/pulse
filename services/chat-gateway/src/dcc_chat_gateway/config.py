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

    snowflake_worker_id_chat: int = Field(default=2, ge=0, le=1023)

    # Guild-icon uploads (owner-only). Resized to 256px webp, served via
    # /api/chat/guild-icons/<guild_id>.webp (cache-buster ?v=… in icon_url).
    guild_icon_upload_dir: str = "./uploads/guild-icons"

    cors_allow_origins: str = "http://localhost:5173,http://127.0.0.1:5173"

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
