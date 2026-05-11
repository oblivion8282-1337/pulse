"""Service configuration."""

from __future__ import annotations

from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=None, extra="ignore")

    auth_jwks_url: str = "http://localhost:8001/.well-known/jwks.json"
    jwt_audience: str = "dcc"
    jwt_issuer: str = "dcc-auth"
    jwks_cache_seconds: int = 3600

    livekit_url: str = "ws://localhost:7880"
    livekit_api_key: str = "devkey"
    livekit_api_secret: str = "devsecretdevsecretdevsecretdevsecret"
    livekit_token_ttl_seconds: int = 60 * 60 * 4  # 4h

    # Redis is used for the voice-presence state (which users are in which
    # voice channel). The webhook handler writes here; chat-gateway reads it.
    redis_url: str = "redis://localhost:6379/0"
    # Self-heal TTL on voice:room:* keys — a lost `participant_left` webhook
    # would otherwise leave a ghost participant forever.
    voice_state_ttl_seconds: int = 60 * 60 * 6  # 6h

    cors_allow_origins: str = "http://localhost:5173,http://127.0.0.1:5173"

    @property
    def cors_origins_list(self) -> list[str]:
        return [o.strip() for o in self.cors_allow_origins.split(",") if o.strip()]


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()
