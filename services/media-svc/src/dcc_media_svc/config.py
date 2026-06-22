"""Service configuration for media-svc."""

from __future__ import annotations

from functools import lru_cache
from typing import Literal

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

    # Self-Host: media-svc must ALSO accept the locally-issued EdDSA Session-JWT
    # (no ``kid``) that chat-gateway forwards on a self-host instance — mirrors
    # chat-gateway / voice-signaling. Without it HQ-streaming 401s on self-host
    # (the forwarded bearer is a self-host session token, not a Cloud RS256
    # access token). Must point at the SAME signing key file the instance mints
    # session tokens with (all-in-one: shared /data/jwt_keys). Cloud sets
    # ``PULSE_INSTANCE_MODE=cloud`` → the self-host path is never taken there.
    pulse_instance_mode: Literal["cloud", "self-host"] = "self-host"
    session_signing_key_file: str = "./data/jwt_keys/session_signing.pem"

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

    # Read-token TTL — minted per WHEP-URL request (after chat-gateway's
    # membership/VIEW_CHANNEL gate) and embedded as ``?token=`` so the auth-hook
    # can verify a viewer was authorised. Only needs to outlive connection setup;
    # the WhepPlayer re-fetches a fresh URL (and token) on every reconnect.
    read_token_ttl_s: int = 60 * 60  # 1h

    # Self-heal TTL on `stream:channel:*` — bounded so a lost poller can't leave
    # a ghost "active" state forever (the poller normally clears it eagerly).
    channel_state_ttl_s: int = 60 * 60 * 6  # 6h

    # Explicit-stop suppression window (`stream:stopping:*`). When the streamer
    # clicks "stop", we update presence instantly AND set this short-lived
    # tombstone so the poller won't re-mark them live from a MediaMTX path that
    # lingers until MediaMTX's own publisher-disconnect detection (readTimeout,
    # ~10s default) catches up. Must exceed that, with margin; cleared early when
    # a fresh stream-token is issued (a restart must not stay suppressed).
    stop_suppression_s: int = 30

    cors_allow_origins: str = "http://localhost:5173,http://127.0.0.1:5173"

    @property
    def cors_origins_list(self) -> list[str]:
        return [o.strip() for o in self.cors_allow_origins.split(",") if o.strip()]


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()
