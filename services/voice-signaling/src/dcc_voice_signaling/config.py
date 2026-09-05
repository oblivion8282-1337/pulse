"""Service configuration."""

from __future__ import annotations

from functools import lru_cache
from typing import Literal

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=None, extra="ignore")

    auth_jwks_url: str = "http://localhost:8001/.well-known/jwks.json"
    jwt_audience: str = "dcc"
    jwt_issuer: str = "dcc-auth"
    jwks_cache_seconds: int = 3600

    # Self-Host identity model (DE 11 / DE 14) — mirrors chat-gateway.
    # ``cloud``   — Cloud instance; tokens are Cloud-issued RS256 Access-JWTs.
    # ``self-host`` — Self-hosted instance; users log in via Cert-Login and
    # chat-gateway mints a local EdDSA *session token* (no ``kid`` header). In
    # self-host mode voice-signaling accepts those just like chat-gateway does
    # (see security.py::decode_token), otherwise ``POST /token`` would 401 with
    # "missing kid" and voice would be unusable. Default matches chat-gateway.
    pulse_instance_mode: Literal["cloud", "self-host"] = "self-host"

    # Path to the locally-generated Ed25519 session-signing key (DE 9). Must be
    # the *same file* chat-gateway minted with, so voice-signaling can verify
    # the EdDSA signature. The allinone self-host image mounts both services at
    # ``/data/jwt_keys/session_signing.pem`` (rendered by 07-render-env.sh as
    # SESSION_SIGNING_KEY_FILE).
    session_signing_key_file: str = "./data/jwt_keys/session_signing.pem"

    livekit_url: str = "ws://localhost:7880"
    # Optional internal address for SERVER-side LiveKit API calls (the
    # reconcile loop + admin mute/disconnect ops). The public ``livekit_url``
    # routes through Caddy/nginx, which is *down during a deploy* — so the
    # startup reconcile (whose whole job is covering the deploy gap) would
    # itself fail on the web layer. Pointing the API client straight at the
    # host (e.g. ``http://host.docker.internal:7880``) removes that dependency.
    # Unset → fall back to ``livekit_url`` (dev/tests, already localhost).
    # Browser clients still get ``livekit_url`` as their ws_url (token.py).
    livekit_api_url: str | None = None
    livekit_api_key: str = "devkey"
    livekit_api_secret: str = "devsecretdevsecretdevsecretdevsecret"
    livekit_token_ttl_seconds: int = 60 * 60 * 4  # 4h

    # Redis is used for the voice-presence state (which users are in which
    # voice channel). The webhook handler writes here; chat-gateway reads it.
    # Default port 6380 matches the Pulse dev compose (see CLAUDE.md "Port-
    # Mapping (lokales Dev)") — auth-hook and media-svc default the same way.
    redis_url: str = "redis://localhost:6380/0"
    # Self-heal TTL on voice:room:* keys — a lost `participant_left` webhook
    # would otherwise leave a ghost participant forever.
    voice_state_ttl_seconds: int = 60 * 60 * 6  # 6h

    # Periodic LiveKit→Redis presence reconciliation (reconcile.py). Polls the
    # actual participant list and rewrites the voice:room:* sets to match —
    # closes the webhook-gap (deploy/restart) and NX-TTL-expiry blind spots the
    # event-driven webhook path cannot heal on its own. Runs once on startup,
    # then every interval. Set enabled=False to fall back to webhook-only.
    voice_reconcile_enabled: bool = True
    voice_reconcile_interval_seconds: int = 30

    cors_allow_origins: str = "http://localhost:5173,http://127.0.0.1:5173"

    # chat-gateway is the source of truth for guild/channel membership. Token
    # issue verifies the caller is a member of the requested voice channel by
    # calling ``GET /channels/{id}``. Unset → token/override routes answer
    # 503 (fail-closed, Audit 2026-09): a deployment that forgets
    # CHAT_GATEWAY_URL must not hand out voice tokens for arbitrary
    # channels. Dev/tests set the URL and mock ``_chat_gateway_request``.
    chat_gateway_url: str | None = None
    chat_gateway_timeout_s: float = 3.0

    # Shared secret for service-to-service POSTs from chat-gateway
    # (kick / ban triggers a LiveKit-eviction + Redis-cleanup pass).
    # Empty string DISABLES the internal endpoint — fail-closed; set
    # this in production (same value on both services' .env).
    internal_service_secret: str = ""

    @property
    def cors_origins_list(self) -> list[str]:
        return [o.strip() for o in self.cors_allow_origins.split(",") if o.strip()]


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()
