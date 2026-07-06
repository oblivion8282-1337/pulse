"""FastAPI factory for the chat-gateway."""

from __future__ import annotations

import asyncio
import logging
from contextlib import asynccontextmanager
from typing import Annotated

import httpx
from fastapi import FastAPI, Header
from fastapi.middleware.cors import CORSMiddleware
from redis.asyncio import Redis

from dcc_chat_gateway import s3
from dcc_chat_gateway.cleanup import cleanup_loop as push_cleanup_loop
from dcc_chat_gateway.cloud_policy_poller import cloud_policy_poller_loop
from dcc_chat_gateway.config import get_settings
from dcc_chat_gateway.crl_poller import crl_poller_loop
from dcc_chat_gateway.db import engine
from dcc_chat_gateway.jwks_pinning import jwks_retry_loop
from dcc_chat_gateway.plugins import (
    ensure_hello_in_allowlist,
    list_allowed_names,
    load_all_with_allowlist,
)
from dcc_chat_gateway.plugins.permissions import log_startup_mode_warning
from dcc_chat_gateway.presence_status import idle_sweeper_loop
from dcc_chat_gateway.pubsub import ConnectionManager
from dcc_chat_gateway.push import ensure_vapid
from dcc_chat_gateway.routes import router
from dcc_chat_gateway.routes.attachments import reaper_loop as attachments_reaper
from dcc_chat_gateway.voice_pull_cleanup import voice_pull_reaper_loop

log = logging.getLogger(__name__)

# Backoff used by the pubsub supervisor between restart attempts.
_SUPERVISOR_BACKOFF = [1.0, 2.0, 5.0, 10.0, 30.0]
_SUPERVISOR_POLL_SECONDS = 5.0

# Field-name blacklist for the 422 raw-body echo. Any key matching
# one of these (case-insensitive, substring) gets redacted from
# the logged payload so a future endpoint that carries a real
# secret in the body doesn't leak it via the 422 path.
_REDACT_KEY_SUBSTR = (
    "token",
    "secret",
    "password",
    "passwd",
    "key",
    "auth",
    "session",
    "cookie",
    "bearer",
    "csrf",
    "pin",
    "otp",
    "2fa",
    "mfa",
    "recovery",
    "credential",
    "private",
)


def _redact(obj):
    """Recursive redactor for the 422 raw-body echo. Module-level
    so tests can import it directly (the handler itself is
    closure-captured inside ``create_app``)."""
    if isinstance(obj, dict):
        return {
            k: (
                "[redacted]"
                if any(s in k.lower() for s in _REDACT_KEY_SUBSTR)
                else _redact(v)
            )
            for k, v in obj.items()
        }
    if isinstance(obj, list):
        return [_redact(v) for v in obj]
    return obj


async def _supervise_pubsub(manager: ConnectionManager) -> None:
    """Restart the ConnectionManager's listener if it dies.

    `ConnectionManager._listen` resets `_started` on a fatal error but cannot
    re-spawn itself; without this watchdog the gateway would silently stop
    fanning out messages until the next request happened to call `start()`.
    """
    attempt = 0
    while True:
        await asyncio.sleep(_SUPERVISOR_POLL_SECONDS)
        if manager.listener_alive():
            attempt = 0
            continue
        wait = _SUPERVISOR_BACKOFF[min(attempt, len(_SUPERVISOR_BACKOFF) - 1)]
        attempt += 1
        log.warning("pubsub listener not alive; restarting in %.0fs (attempt %d)", wait, attempt)
        await asyncio.sleep(wait)
        try:
            await manager.start()
        except Exception:  # noqa: BLE001
            log.exception("pubsub restart failed; will retry")


@asynccontextmanager
async def lifespan(app: FastAPI):
    settings = get_settings()
    # Fail fast: a self-host must have PULSE_INSTANCE_ID set to a non-zero value.
    # Without it every instance would compute the same pairwise-subs (DE 11 A.13).
    # Skip in test mode (skip_redis=True) so unit tests with default settings pass.
    if (
        not getattr(app.state, "skip_redis", False)
        and settings.pulse_instance_mode == "self-host"
        and settings.pulse_instance_id == 0
    ):
        raise RuntimeError(
            "PULSE_INSTANCE_ID must be set to a non-zero value on a self-host. "
            "Set PULSE_INSTANCE_ID in your .env file to the Snowflake-ID assigned "
            "by the Cloud at approval time."
        )
    # Fail-fast: der .env.example-Platzhalter ist öffentlich bekannt — damit zu
    # starten hieße, die internen Service-zu-Service-Endpoints mit einem
    # allgemein bekannten "Secret" zu schützen. Leer = deaktiviert, ok.
    if settings.internal_service_secret == "__CHANGE_ME__":
        raise RuntimeError(
            "INTERNAL_SERVICE_SECRET is still the .env.example placeholder __CHANGE_ME__ — "
            "set a real secret (same value on auth-svc/voice-signaling) or leave it unset."
        )
    # Resolve / auto-generate the Web-Push VAPID keypair. Logs the
    # *public* half (the browser needs it; not secret) on first call;
    # NEVER logs the private PEM. ``ensure_vapid`` is idempotent so
    # tests + repeated startups are safe.
    vapid = ensure_vapid(settings)
    if vapid is not None:
        log.info("web-push VAPID public key: %s", vapid.public_b64url)
    else:
        log.warning("web-push disabled: VAPID key unavailable")
    redis: Redis | None = None
    manager: ConnectionManager | None = None
    media_svc_http: httpx.AsyncClient | None = None
    supervisor: asyncio.Task | None = None
    reaper: asyncio.Task | None = None
    push_cleanup: asyncio.Task | None = None
    idle_sweeper: asyncio.Task | None = None
    voice_pull_reaper: asyncio.Task | None = None
    crl_poller: asyncio.Task | None = None
    cloud_policy_task: asyncio.Task | None = None
    jwks_retry: asyncio.Task | None = None
    owns_manager = False
    if getattr(app.state, "skip_redis", False):
        # Tests pre-wire connection_manager onto the app — leave it alone.
        pass
    else:
        redis = Redis.from_url(settings.redis_url, decode_responses=False)
        manager = ConnectionManager(redis)
        # Wire the permission filter's DB access through ``routes.ws_ops`` —
        # tests rebind ``routes.ws_ops.SessionLocal`` to a file-backed DB
        # (that module owns the WS op-loop's DB access since Phase B), and
        # this indirection lets the manager pick up the same factory the
        # WS endpoint already uses. Late import dodges the routes ↔ pubsub
        # circular dependency at module load.
        from dcc_chat_gateway.routes import ws_ops as _routes_ws_ops
        manager.set_session_factory(lambda: _routes_ws_ops.SessionLocal())
        await manager.start()
        app.state.redis = redis
        app.state.connection_manager = manager
        # media-svc HTTP client: shared across all stream-token and WHEP requests
        # to reuse TCP connections instead of creating one per request.
        media_svc_http = httpx.AsyncClient(timeout=settings.media_svc_timeout_s)
        app.state.media_svc_http = media_svc_http
        owns_manager = True
        supervisor = asyncio.create_task(_supervise_pubsub(manager), name="dcc-pubsub-supervisor")
        # Orphan-attachment reaper — sweeps pending uploads >1 h old.
        reaper = asyncio.create_task(attachments_reaper(), name="dcc-attachments-reaper")
        # Web-Push subscription cleanup — drops subs idle >N days.
        push_cleanup = asyncio.create_task(
            push_cleanup_loop(settings, engine), name="dcc-push-subscription-cleanup"
        )
        # Presence idle sweeper — demotes ``online`` users with stale
        # activity to ``idle`` (Etappe 3).
        idle_sweeper = asyncio.create_task(
            idle_sweeper_loop(redis), name="dcc-presence-idle-sweeper"
        )
        # Voice-pull reaper — backstop that revokes temporary visibility
        # grants the participant_left webhook missed (or that the target
        # never connected to). See voice_pull_cleanup.voice_pull_reaper_loop.
        voice_pull_reaper = asyncio.create_task(
            voice_pull_reaper_loop(settings, engine, redis), name="dcc-voice-pull-reaper"
        )
        # CRL poller — fetches revoked-cert list from Cloud every 30 s.
        # Without this task the ``auth:revoked:certs`` Redis set stays empty
        # in prod and revoked certs would pass validation (security hole).
        crl_poller = asyncio.create_task(
            crl_poller_loop(redis, settings.pulse_cloud_origin),
            name="dcc-crl-poller",
        )
        # Cloud policy poller — fetches the version-policy document every 6 h
        # (configurable via ``cloud_policy_poll_interval``). Persists to Redis
        # so Phase-4 frontend and the WS hello-frame can surface update banners.
        cloud_policy_task = asyncio.create_task(
            cloud_policy_poller_loop(
                redis,
                settings.pulse_cloud_origin,
                settings.cloud_policy_poll_interval,
            ),
            name="dcc-cloud-policy-poller",
        )
        # Dropbox / Ablage trash-retention sweep — fires once an hour to
        # purge entries that have been in the trash longer than each
        # guild's configured retention window. Best-effort: skips the
        # row if MinIO delete fails (next pass retries).
        from dcc_chat_gateway.routes.dropbox_admin import schedule_sweep

        dropbox_sweep_task = schedule_sweep(
            asyncio.get_event_loop(), manager
        )
        # JWKS cold-start handling (Phase 3.1 Punkt 12): if Redis has no
        # cached JWKS at startup (cold cache + Cloud unreachable), mark
        # jwks_ready=False and launch a retry loop that polls every 30 s.
        # WS connections return 4046 while jwks_ready is False.
        raw_jwks = await redis.get("auth:jwks:cached")
        if raw_jwks:
            app.state.jwks_ready = True
        else:
            app.state.jwks_ready = False
            log.warning(
                "jwks_cold_start: Redis JWKS cache empty at startup — "
                "WS connections will be rejected (4046) until JWKS is available"
            )
            jwks_retry = asyncio.create_task(
                jwks_retry_loop(redis, settings, app.state),
                name="dcc-jwks-retry",
            )
        app.state.jwks_changed_unexpectedly = False
        # Plugin-System: log startup warning if permission mode is not 'strict'.
        log_startup_mode_warning()
        # Plugin-System: Allowlist-gegateter Load.
        # 1. Self-Heal: ``hello`` muss immer in der Allowlist sein.
        # 2. Allowlist-Snapshot aus der DB lesen.
        # 3. Plugin-Loader mit Snapshot aufrufen — nur erlaubte Plugins
        #    werden aktiviert; entdeckte aber nicht-erlaubte bleiben für
        #    die Admin-API sichtbar.
        # Snapshot landet auf ``app.state.plugin_allowlist`` (frozenset),
        # damit der WS-Op-Gate ohne DB-Hit pro Op prüfen kann.
        # Errors pro Plugin werden geloggt; die Lifespan startet auch
        # bei Plugin-Fehlern durch. Mode für den Permission-Gate (intern):
        # ``$PULSE_PLUGIN_PERMISSIONS`` — siehe ``plugins.permissions``.
        # Den Plugin-Loader auf demselben SessionLocal laufen lassen,
        # den der WS-Op-Pfad nutzt. Tests patchen ``routes.ws_ops.SessionLocal``
        # auf eine file-backed DB; der direkte Import ``dcc_chat_gateway.db.
        # SessionLocal`` würde die Memory-DB-Factory einsammeln (die nie
        # gepatched wird) — Lifespan würde scheitern und die Allowlist
        # bliebe leer. Same indirection as ``manager.set_session_factory``
        # weiter oben.
        try:
            async with _routes_ws_ops.SessionLocal() as session:
                await ensure_hello_in_allowlist(session)
                allowed = await list_allowed_names(session)
            app.state.plugin_allowlist = frozenset(allowed)
            result = load_all_with_allowlist(allowed)
            # Plugin-System PR3: Plugins können eigene Pub/Sub-Channels
            # deklarieren (``[plugin.uses].channels`` im Manifest).
            # ConnectionManager subscribt seine Built-ins bei ``start()`` —
            # die Plugin-Channels werden hier nachgereicht, damit der
            # ``_listen``-Loop sie auch empfängt.
            extra_channels: list[str] = []
            for manifest in result.loaded:
                extra_channels.extend(manifest.uses.channels)
            if extra_channels and manager is not None:
                try:
                    await manager.subscribe_plugin_channels(
                        list(dict.fromkeys(extra_channels))
                    )
                except Exception:  # noqa: BLE001
                    log.exception(
                        "plugin channel subscribe failed; broadcasts may not reach clients"
                    )
        except Exception:  # noqa: BLE001
            log.exception("plugin loader failed; continuing without plugins")
            app.state.plugin_allowlist = frozenset()
    try:
        yield
    finally:
        if owns_manager:
            bg_tasks = (
                supervisor, reaper, push_cleanup, idle_sweeper,
                voice_pull_reaper, crl_poller, cloud_policy_task,
                jwks_retry, dropbox_sweep_task,
            )
            for task in bg_tasks:
                if task is not None:
                    task.cancel()
                    try:
                        await task
                    except (asyncio.CancelledError, Exception):  # noqa: BLE001
                        pass
            if manager is not None:
                await manager.stop()
            if redis is not None:
                try:
                    await redis.aclose()
                except Exception:  # noqa: BLE001
                    pass
            if media_svc_http is not None:
                try:
                    await media_svc_http.aclose()
                except Exception:  # noqa: BLE001
                    pass
        # Close the lazily-initialised S3 clients regardless of which branch
        # we took above — they may have been created from a non-Redis test
        # path too.
        await s3.shutdown_clients()
        # Same for the voice-evict httpx singleton (kick/ban → voice-signaling).
        from dcc_chat_gateway import voice_evict

        await voice_evict.shutdown_client()


def create_app(*, skip_redis: bool = False) -> FastAPI:
    settings = get_settings()
    # Scrub ``token=…`` (WS query-param auth) from uvicorn access logs before
    # any request is served. Idempotent — safe across repeated create_app calls.
    from dcc_chat_gateway.log_filters import install_access_log_redaction
    install_access_log_redaction()
    app = FastAPI(title="dcc-chat-gateway", version="0.1.0", lifespan=lifespan)

    # Validation-error log: every 422 carries away the offending body
    # so a future bug report can read it from the container log without
    # reproducing. Bound to 1 KiB to avoid log floods from abusive
    # clients; the FastAPI ``RequestValidationError`` fires before the
    # route handler runs, so we still see the unmodified raw payload.
    import json as _json

    import structlog as _sl
    from fastapi.exceptions import RequestValidationError

    @app.exception_handler(RequestValidationError)
    async def _log_422(request, exc: RequestValidationError):
        try:
            raw = (await request.body()).decode(errors="replace")[:1024]
        except Exception:  # noqa: BLE001
            raw = "<unreadable>"
        # Try to redact sensitive fields before logging. The body
        # might not be JSON (e.g. multipart upload-url cancel) — in
        # that case we fall back to a truncated raw echo. The 1 KiB
        # cap from before is preserved so abusive clients can't
        # flood the log.
        logged_body: str | dict | list = "<non-json>"
        try:
            parsed = _json.loads(raw)
            logged_body = _redact(parsed)
        except Exception:  # noqa: BLE001 — not JSON, keep raw
            logged_body = raw
        _sl.get_logger("dcc_chat_gateway").warning(
            "request_validation_error",
            method=request.method,
            path=request.url.path,
            errors=_json.loads(_json.dumps(exc.errors(), default=str))[:6],
            raw_body=logged_body,
        )
        # Re-raise as the default 422 — FastAPI's own handler takes over.
        from fastapi.responses import JSONResponse
        return JSONResponse(
            status_code=422,
            content={"detail": _json.loads(_json.dumps(exc.errors(), default=str))},
        )
    app.state.skip_redis = skip_redis
    # Default-Snapshot, damit Tests ohne Lifespan (REST-only-Fixture)
    # ein definiertes ``plugin_allowlist`` lesen können. Die Lifespan
    # überschreibt das mit dem DB-Snapshot.
    app.state.plugin_allowlist = frozenset()
    # Phase 3.1 defaults — overwritten by lifespan when Redis is live.
    # Tests that set skip_redis=True get jwks_ready=True (no JWKS gate in unit tests).
    app.state.jwks_ready = True
    app.state.jwks_changed_unexpectedly = False
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins_list,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )
    app.include_router(router)

    @app.get("/internal/jwks-status")
    async def jwks_status(
        x_pulse_internal_secret: Annotated[str | None, Header()] = None,
    ) -> dict:
        """Internal JWKS-pin status healthcheck (Phase 3.1 stub).

        Returns the current pin-flag states.  Gated behind the same
        INTERNAL_SERVICE_SECRET header used by /internal/health-probe so
        that the nginx proxy does not need an explicit deny block.
        Phase 4 will add a full admin UI banner driven by this.
        """
        # Reuse the same constant-time secret-check pattern as health-probe.
        from dcc_chat_gateway.routes.health import _check_internal_secret  # noqa: PLC0415
        _check_internal_secret(x_pulse_internal_secret)
        return {
            "jwks_ready": getattr(app.state, "jwks_ready", True),
            "jwks_changed_unexpectedly": getattr(
                app.state, "jwks_changed_unexpectedly", False
            ),
        }

    return app


app = create_app()
