"""Service configuration for the frps relay auth plugin."""
from __future__ import annotations
from functools import lru_cache
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=None, extra="ignore")

    # auth-svc base URL; the plugin POSTs {subdomain, token} to /selfhost/relay/auth.
    auth_svc_url: str = "http://127.0.0.1:8001"
    # Shared internal secret (X-Pulse-Internal-Secret) — same value auth-svc holds.
    internal_service_secret: str | None = None
    # Base domain appended to the frp routing-subdomain (slug) to reconstruct the
    # full subdomain that auth-svc stores/validates.
    relay_base_domain: str = "relay.howispulse.com"
    # Fail-closed timeout for the auth-svc call.
    auth_timeout_seconds: float = 3.0


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()
