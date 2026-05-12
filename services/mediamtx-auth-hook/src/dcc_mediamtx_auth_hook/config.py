"""Service configuration for the MediaMTX auth hook."""

from __future__ import annotations

from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=None, extra="ignore")

    # Redis holds the publish stream-tokens issued by media-svc
    # (key: ``stream:token:<token>``) plus the per-channel publisher record
    # (key: ``stream:active:channel-<channel_id>``) that this hook writes on a
    # successful publish-auth so media-svc's poller knows *who* is streaming.
    redis_url: str = "redis://localhost:6380/0"

    # Self-heal TTL on ``stream:active:channel-*`` — media-svc's poller refreshes
    # / clears it against the MediaMTX reality, but a TTL bounds the worst case
    # if both the poller and a MediaMTX disconnect notification are lost.
    publisher_ttl_seconds: int = 60 * 60 * 6  # 6h

    bind_host: str = "127.0.0.1"
    bind_port: int = 8005


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()
