"""Service configuration loaded from environment variables."""

from __future__ import annotations

from functools import lru_cache
from pathlib import Path

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


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
