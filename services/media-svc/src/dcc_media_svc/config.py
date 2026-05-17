"""Service configuration for media-svc."""

from __future__ import annotations

from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=None, extra="ignore")

    # Redis: holds the issued stream-tokens, the per-channel publisher record
    # written by the auth hook, and the public per-channel stream state. Also
    # the pub/sub channel ``stream:events``.
    redis_url: str = "redis://localhost:6380/0"

    # JWKS endpoint of auth-svc — media-svc verifies the caller's Pulse access
    # token (RS256) on `POST /channels/{id}/stream-token`. The caller is
    # chat-gateway, which forwards the user's access token after checking the
    # channel membership; the verified `sub` claim becomes the token's user_id.
    auth_jwks_url: str = "http://localhost:8001/.well-known/jwks.json"
    jwt_audience: str = "dcc"
    jwt_issuer: str = "dcc-auth"
    jwks_cache_seconds: int = 3600

    # MediaMTX control API — localhost-only on the box MediaMTX runs on, which is
    # the same box media-svc is co-located on in prod. In dev that's the local
    # `streaming/server/docker-compose.yml` MediaMTX (network_mode: host).
    mediamtx_api_url: str = "http://localhost:9997/v3/paths/list"
    # How often the presence poller hits the MediaMTX API.
    poll_interval_s: float = 3.0

    # Ingest endpoint for building the publish push-URL handed to the GSR sidecar.
    # The "rtmp" protocol is served over TLS (rtmps://) so the token isn't on the
    # wire in cleartext — RTMPS lives on its own port (1936 in prod).
    mediamtx_ingest_host: str = "localhost"
    mediamtx_rtmps_port: int = 1936
    mediamtx_srt_port: int = 8890

    # Public WebRTC base for the WHEP playback URL (dev: local MediaMTX webrtc;
    # prod later: https://stream.unicutmedia.com).
    mediamtx_public_base: str = "http://localhost:8889"

    # Stream-token TTL — long enough for a whole streaming session. The token is
    # presented on stream start and remains valid for the connection's lifetime.
    token_ttl_s: int = 60 * 60 * 4  # 4h

    # Self-heal TTL on `stream:channel:*` — bounded so a lost poller can't leave
    # a ghost "active" state forever (the poller normally clears it eagerly).
    channel_state_ttl_s: int = 60 * 60 * 6  # 6h

    bind_host: str = "127.0.0.1"
    bind_port: int = 8004

    cors_allow_origins: str = "http://localhost:5173,http://127.0.0.1:5173"

    @property
    def cors_origins_list(self) -> list[str]:
        return [o.strip() for o in self.cors_allow_origins.split(",") if o.strip()]


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()
