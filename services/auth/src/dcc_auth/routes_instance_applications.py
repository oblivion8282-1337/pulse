"""User-facing Self-Hoster endpoints — Phase 2.2.

GET    /me/instances                    -- eigene registrierte Instanzen
POST   /me/instances/{id}/env-file            -- fertige .env (inkl. frischem Secret)
POST   /me/instances/{id}/bootstrap-token     -- One-Time-Installer-Token

Die Antrags-Endpoints (``/me/instance-applications``) leben seit dem vereinten
Antragssystem (Migration 0044) in ``routes_applications.py``.
"""

from __future__ import annotations

import asyncio
import secrets
from datetime import UTC, datetime, timedelta
from typing import Literal

from fastapi import APIRouter, HTTPException, Request, Response, status
from pydantic import BaseModel, Field
from sqlalchemy import select

from dcc_auth.bootstrap import (
    bootstrap_redeemed,
    drop_unredeemed_tokens,
    generate_bootstrap_token,
    hash_bootstrap_token,
)
from dcc_auth.browser_sessions import validate_session
from dcc_auth.config import get_settings
from dcc_auth.db import SessionDep
from dcc_auth.instance_env_file import render_instance_env
from dcc_auth.models import User
from dcc_auth.models_instances import (
    InstanceBootstrapToken,
    RegisteredInstance,
    UserInstanceMembership,
)
from dcc_auth.routes import _check_rate
from dcc_auth.security import hash_password
from dcc_auth.snowflake import next_id

router = APIRouter(tags=["self-host"])

# ---------------------------------------------------------------------------
# Auth helper
# ---------------------------------------------------------------------------


async def _require_user(request: Request, db) -> User:
    """Validate session cookie → User.  Raises HTTP 401 on failure."""
    import uuid

    raw = request.cookies.get("pulse_session")
    if not raw:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, detail="missing session cookie")
    try:
        sid = uuid.UUID(raw)
    except ValueError as exc:
        raise HTTPException(
            status.HTTP_401_UNAUTHORIZED, detail="invalid session cookie"
        ) from exc
    row = await validate_session(db, sid)
    if row is None:
        raise HTTPException(
            status.HTTP_401_UNAUTHORIZED, detail="session expired or not found"
        )
    user = await db.get(User, row.user_id)
    if user is None:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, detail="user not found")
    if user.disabled or user.is_suspended:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, detail="account disabled")
    return user


def _require_self_host_enabled(user: User) -> None:
    """Cloud-Gate (④) — sitzt BEWUSST nur auf ``generate_env_file``.

    Entscheidung 2026-07-13 (der frühere Docstring verlangte das Gate auch auf
    ``mint_bootstrap_token`` — das war veraltet, nicht der Code): Der
    Bootstrap-Mint ist bereits über den Owner-Check (``registered_by ==
    user.id``) plus eine vom Admin genehmigte, aktive Instanz gedeckt, und der
    Redeem verweigert nicht-aktive Instanzen. Die Server-App nutzt den Mint
    außerdem mit ``reset=true`` zur Crash-/Gerätewechsel-Recovery — ein
    ``self_host_enabled``-Gate dort würde App-Host-Owner nach einem Admin-
    Revoke+Re-Approve-Zyklus oder VPS-Owner (Flag greift bei denen nie)
    aussperren. Das Flag bleibt nur für den env-File-Download nötig, weil der
    jederzeit ein frisches ``client_secret`` rotieren kann (s. CLAUDE.md
    „Self-Host-Approval-Flow")."""
    if not user.self_host_enabled:
        raise HTTPException(status.HTTP_403_FORBIDDEN, detail="self-hosting not enabled")


# ---------------------------------------------------------------------------
# Schemas
# ---------------------------------------------------------------------------


class InstanceOut(BaseModel):
    id: str  # Snowflake-String-API
    hostname: str
    client_id: str
    worker_id_chat: int
    worker_id_voice: int
    worker_id_media: int
    status: Literal["active", "suspended"]
    # vps = klassischer Self-Host, app_host = Ein-Knopf-Container aus der App.
    # Das Frontend blendet app_host-Instanzen aus "Meine Instanzen" aus.
    origin: Literal["vps", "app_host"] = "vps"
    registered_at: datetime
    # Per-User-Präferenzen aus user_instance_memberships (account-basiert →
    # geräteübergreifend). NULL/Default, wenn keine Membership im Kontext.
    user_label: str | None = None
    notification_mode: Literal["all", "mentions", "none"] = "mentions"


class InstancePreferencesIn(BaseModel):
    """Partielles Update der geräteübergreifenden Server-Präferenzen. Nur
    gesetzte Felder werden geändert (``model_fields_set``); ``label=None``
    setzt den Anzeigenamen explizit zurück (= Hostname anzeigen)."""

    label: str | None = Field(default=None, max_length=100)
    notification_mode: Literal["all", "mentions", "none"] | None = None


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _instance_to_out(
    inst: RegisteredInstance, membership: UserInstanceMembership | None = None
) -> InstanceOut:
    return InstanceOut(
        id=str(inst.id),
        # App-Host-Instanzen tragen als ``hostname`` nur einen synthetischen
        # Platzhalter (``app-<id>.…``, bei der Approval vergeben, existiert im
        # DNS nicht). Erreichbar sind sie unter der Relay-Subdomain, die erst
        # beim Pairing entsteht. Der Client baut aus diesem Feld seine
        # Server-URL — ohne den Fallback zeigt er auf einen toten Host und der
        # Cert-Login scheitert mit 401 (``cert_invalid``).
        #
        # NUR für App-Hosts: ein VPS hat eine echte Adresse; eine (fälschlich
        # oder historisch) vergebene Relay-Subdomain darf sie NIE verdrängen —
        # Clients synchronisieren dieses Feld in ihre Server-Liste und
        # verbänden sich sonst gegen einen toten Tunnel (Vorfall 2026-07-14).
        hostname=(
            (inst.relay_subdomain or inst.hostname)
            if inst.origin == "app_host"
            else inst.hostname
        ),
        client_id=inst.client_id,
        worker_id_chat=inst.worker_id_chat,
        worker_id_voice=inst.worker_id_voice,
        worker_id_media=inst.worker_id_media,
        status=inst.status,  # type: ignore[arg-type]
        origin=inst.origin,  # type: ignore[arg-type]
        registered_at=inst.registered_at,
        user_label=membership.user_label if membership else None,
        notification_mode=(
            membership.notification_mode if membership else "mentions"  # type: ignore[arg-type]
        ),
    )


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------


@router.get(
    "/me/instances",
    response_model=list[InstanceOut],
)
async def list_my_instances(
    request: Request,
    db: SessionDep,
) -> list[InstanceOut]:
    """Eigene registrierte Instanzen abrufen. client_secret wird NIE zurückgegeben."""
    user = await _require_user(request, db)

    # Liest aus ``user_instance_memberships`` (= Account-basierte Server-Liste).
    # Vor dem Vault-Drop (Migration 0026 → 0037) war das ein Filter über
    # ``registered_by`` — die neue Tabelle ist die Quelle der Wahrheit und
    # erlaubt später auch eingeladene Nicht-Owner-User (Phase 4-6).
    # Soft-delete (routes_instance_delete) ausblenden.
    stmt = (
        select(RegisteredInstance, UserInstanceMembership)
        .join(
            UserInstanceMembership,
            UserInstanceMembership.instance_id == RegisteredInstance.id,
        )
        .where(
            UserInstanceMembership.user_id == user.id,
            RegisteredInstance.status != "deleted",
        )
        .order_by(RegisteredInstance.registered_at.desc())
    )
    rows = (await db.execute(stmt)).all()
    return [_instance_to_out(inst, membership) for inst, membership in rows]


@router.post(
    "/me/instances/{instance_id}/membership",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def join_instance_membership(
    instance_id: str,
    request: Request,
    db: SessionDep,
) -> None:
    """Den eingeloggten Cloud-User als Mitglied einer Self-Host-Instanz
    eintragen — so erscheint ein per Einladung beigetretener Server auch auf
    anderen Geräten (Account-basierte Server-Liste, ``GET /me/instances``).

    Bisher legte nur der Owner-Pfad (Approval/Bootstrap-Redeem) eine Membership
    an; ein eingeladener Nicht-Owner hatte nur den gerätelokalen
    ``pulse.servers``-Eintrag → im Browser unsichtbar. Dieser Endpoint schließt
    die Lücke (die in ``UserInstanceMembership`` vorbereitete Phase-4-6-Rolle).

    Idempotent. Eine bestehende ``owner``-Rolle wird NICHT herabgestuft. Die
    Cloud verifiziert die Self-Host-seitige Mitgliedschaft bewusst NICHT
    (Cert-Modell: Self-Hosts sind isolierte DB-Welten) — die Server-Liste war
    immer nur eine schwache Tracking-Dimension, kein Zugriffsbeweis. Ohne echten
    Cert-Grant kommt der User auf dem Self-Host trotzdem nicht rein; der Client
    ruft den Endpoint ohnehin erst nach erfolgreichem Cert-Login auf.
    """
    user = await _require_user(request, db)
    try:
        iid = int(instance_id)
    except ValueError:
        # ``from None`` an allen diesen Stellen: eine nicht-numerische ID ist
        # erwartetes Verhalten, kein Fehlerfall — ein angehaengter Traceback
        # waere nur Log-Laerm.
        raise HTTPException(
            status.HTTP_404_NOT_FOUND, detail="Instanz nicht gefunden"
        ) from None
    inst = await db.get(RegisteredInstance, iid)
    if inst is None or inst.status == "deleted":
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="Instanz nicht gefunden")
    if await db.get(UserInstanceMembership, (user.id, iid)) is None:
        db.add(
            UserInstanceMembership(user_id=user.id, instance_id=iid, role="member")
        )
        await db.commit()


@router.delete(
    "/me/instances/{instance_id}/membership",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def leave_instance_membership(
    instance_id: str,
    request: Request,
    db: SessionDep,
) -> None:
    """Cloud-seitige Membership entfernen, wenn der User einen Self-Host-Server
    entfernt (= austritt). Gegenstück zu :func:`join_instance_membership` —
    ohne das würde der Server beim nächsten ``GET /me/instances`` auf anderen
    Geräten wieder auftauchen.

    Der Owner kann seine Membership so NICHT wegwerfen (er bleibt Owner; zum
    Loswerden dient ``DELETE /me/instances/{id}`` = Instanz löschen) → 403.
    Idempotent: keine Membership → 204.
    """
    user = await _require_user(request, db)
    try:
        iid = int(instance_id)
    except ValueError:
        raise HTTPException(
            status.HTTP_404_NOT_FOUND, detail="Instanz nicht gefunden"
        ) from None
    existing = await db.get(UserInstanceMembership, (user.id, iid))
    if existing is None:
        return
    if existing.role == "owner":
        raise HTTPException(
            status.HTTP_403_FORBIDDEN, detail="owner_cannot_leave_instance"
        )
    await db.delete(existing)
    await db.commit()


@router.patch(
    "/me/instances/{instance_id}/preferences",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def update_instance_preferences(
    instance_id: str,
    payload: InstancePreferencesIn,
    request: Request,
    db: SessionDep,
) -> None:
    """Geräteübergreifende Server-Präferenzen (Anzeigename + Notification-Modus)
    setzen. Damit gelten Umbenennung und Stummschaltung eines Self-Host-Servers
    auf allen Geräten, nicht nur lokal. Partiell: nur gesetzte Felder ändern.
    404, wenn der User keine Membership auf der Instanz hat."""
    user = await _require_user(request, db)
    try:
        iid = int(instance_id)
    except ValueError:
        raise HTTPException(
            status.HTTP_404_NOT_FOUND, detail="Instanz nicht gefunden"
        ) from None
    membership = await db.get(UserInstanceMembership, (user.id, iid))
    if membership is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="Instanz nicht gefunden")
    fields = payload.model_fields_set
    if "label" in fields:
        membership.user_label = payload.label
    if "notification_mode" in fields and payload.notification_mode is not None:
        membership.notification_mode = payload.notification_mode
    await db.commit()


class ReissueIn(BaseModel):
    """Optionaler Body der beiden „Zugang neu ausstellen"-Pfade.

    ``reset=true`` hebt die jeweilige One-Shot-Sperre auf (``.env``-Download
    bzw. Bootstrap-Mint) — der bewusste Recovery-Weg nach Datei- oder
    Geräteverlust. Ein Modell für beide, weil es derselbe Gedanke ist; zwei
    getrennte Formen dafür wären nur eine Falle für den nächsten Leser. Das
    Einlösen rotiert in beiden Fällen die Credentials, alte sterben sofort.
    """

    reset: bool = False


@router.post(
    "/me/instances/{instance_id}/env-file",
    response_class=Response,
)
async def generate_env_file(
    instance_id: str,
    request: Request,
    db: SessionDep,
    payload: ReissueIn | None = None,
) -> Response:
    """Erzeugt die komplette, sofort lauffähige ``.env`` für den allinone-Container.

    Nur der Eigentümer (404 statt 403 gegen Existence-Leak). Anders als ein
    bloßes Template enthält diese ``.env`` ALLE Werte gesetzt — inklusive eines
    **frisch generierten** ``PULSE_CLOUD_CLIENT_SECRET``.

    **One-shot nach erstem Download:** der erste Aufruf rotiert das Secret und
    setzt ``env_file_downloaded_at``; jeder weitere → 403. Verhindert, dass
    dieser Pfad die One-Shot-Semantik von ``mint_bootstrap_token`` aushebelt
    (Side-Channel auf frische Credentials).

    **Ausser bei ``reset=true``** — der bewusste „Zugangsdaten neu ausstellen"-
    Pfad, gleiches Muster wie beim Bootstrap-Mint. Grund (2026-07-27, beim
    Testen aufgefallen): ein fehlgeschlagener Download — Browser blockt, Platte
    voll, Datei verlegt — kostete sonst einen kompletten neuen Antrag, obwohl
    der Owner derselbe ist. Das war streng ohne Sicherheitsgewinn.

    Die Invariante „ein laufender Server pro Antrag" bleibt trotzdem: das
    Secret rotiert bei JEDEM Aufruf, ein bereits laufender Container verliert
    seinen Cloud-Zugang also sofort. Aus einer Instanz entstehen nie zwei
    lebende Server — es wechselt nur, welcher der lebende ist. Genau das muss
    die Oberflaeche vorher deutlich sagen.

    Der Klartext des Secrets geht **ausschließlich** hier in der Antwort raus;
    in der DB liegt nur der Argon2-Hash. Secret wird NIE geloggt. Der
    Datei-Inhalt selbst (inkl. der Var-Namen, die exakt zum Container passen
    müssen) steht in ``instance_env_file.py``.
    """
    user = await _require_user(request, db)
    _require_self_host_enabled(user)
    settings = get_settings()
    await _check_rate(request, "bootstrap_mint", settings.rate_limit_bootstrap_mint)

    try:
        iid = int(instance_id)
    except ValueError:
        raise HTTPException(
            status.HTTP_404_NOT_FOUND, detail="Instanz nicht gefunden"
        ) from None

    inst = await db.get(RegisteredInstance, iid, with_for_update=True)
    if inst is None or inst.registered_by != user.id or inst.status == "deleted":
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="Instanz nicht gefunden")

    # „Schon versorgt" heisst: ueber DIESEN Weg (env_file_downloaded_at) ODER
    # ueber den Schnellinstaller (eingeloestes Bootstrap-Token). Beide liefern
    # dieselben Credentials und rotieren dasselbe Secret — der zweite Weg macht
    # den ersten tot. Frueher zaehlte hier nur der eigene Weg, ein Download nach
    # abgebrochenem Installer-Lauf rotierte deshalb wortlos die Zugangsdaten
    # weg, die schon auf dem Server lagen (s. bootstrap.bootstrap_redeemed).
    schon_selbst_geladen = inst.env_file_downloaded_at is not None
    bereits_versorgt = schon_selbst_geladen or await bootstrap_redeemed(db, iid)
    if bereits_versorgt and not (payload and payload.reset):
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            detail=(
                "Dieser Server wurde bereits eingerichtet — neu ausstellen ist moeglich, "
                "der bisher laufende Server verliert dabei seinen Zugang"
            ),
        )

    # Jede Credential-Ausgabe entwertet noch offene Installer-Tokens, sonst
    # erschlaegt ein spaet eingeloestes Token die gerade verteilte Datei.
    await drop_unredeemed_tokens(db, iid)

    new_secret = secrets.token_urlsafe(32)
    inst.client_secret = await asyncio.to_thread(hash_password, new_secret)
    inst.env_file_downloaded_at = datetime.now(UTC)  # atomar mit Secret-Rotation
    await db.commit()

    return Response(
        content=render_instance_env(
            inst,
            client_secret=new_secret,
            admin_email=user.email or f"admin@{inst.hostname}",
            cloud_origin=settings.pulse_oidc_issuer,
        ),
        media_type="text/plain; charset=utf-8",
        headers={
            "Content-Disposition": f'attachment; filename="pulse-instance-{inst.id}.env"'
        },
    )


# ---------------------------------------------------------------------------
# Ein-Befehl-Installer — Mint eines One-Time-Bootstrap-Tokens
# ---------------------------------------------------------------------------


class BootstrapTokenOut(BaseModel):
    token: str
    expires_at: datetime
    ttl_seconds: int


@router.post(
    "/me/instances/{instance_id}/bootstrap-token",
    response_model=BootstrapTokenOut,
    status_code=status.HTTP_201_CREATED,
)
async def mint_bootstrap_token(
    instance_id: str,
    request: Request,
    db: SessionDep,
    payload: ReissueIn | None = None,
) -> BootstrapTokenOut:
    """Mintet einen One-Time-Bootstrap-Token für den Ein-Befehl-Installer.

    Nur der Owner der Instanz (404 statt 403 gegen Existence-Leak). Räumt alle
    vorherigen, nicht-eingelösten Tokens dieser Instanz weg — ein „neu
    generieren" entwertet den alten sofort. Nach erfolgreichem Redeem sind
    weitere Mints geblockt (Hijack-Härtung: eine gekaperte Session kann keine
    laufende Instanz still übernehmen) — AUSSER der Owner setzt explizit
    ``reset=true``: der bewusste Recovery-Pfad nach Gerätewechsel/Creds-Verlust.
    Das Einlösen rotiert client_secret + Tunnel-Token, ein alter Server verliert
    damit sofort seinen Cloud-Zugang — es entstehen nie zwei lebende Server aus
    einer Instanz. Token-Verlust vor Redeem (TTL abgelaufen) erlaubt weiteres
    Mint.
    """
    user = await _require_user(request, db)
    settings = get_settings()
    await _check_rate(request, "bootstrap_mint", settings.rate_limit_bootstrap_mint)

    try:
        iid = int(instance_id)
    except ValueError:
        raise HTTPException(
            status.HTTP_404_NOT_FOUND, detail="Instanz nicht gefunden"
        ) from None

    inst = await db.get(RegisteredInstance, iid)
    if inst is None or inst.registered_by != user.id or inst.status == "deleted":
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="Instanz nicht gefunden")

    # One-shot nach erfolgreichem Setup: ein bereits eingelöstes Token
    # blockiert weitere Mints — außer beim expliziten Reset (s. Docstring).
    # Audit-Spur bleibt in der Token-Tabelle (Redeem setzt nur consumed_at,
    # löscht nicht; auch der Reset löscht nur uneingelöste Tokens).
    if await bootstrap_redeemed(db, iid) and not (payload and payload.reset):
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            detail="Bootstrap bereits eingelöst — für weitere Server neuen Antrag stellen",
        )

    await drop_unredeemed_tokens(db, iid)

    token = generate_bootstrap_token()
    ttl = settings.bootstrap_token_ttl_seconds
    expires_at = datetime.now(UTC) + timedelta(seconds=ttl)
    db.add(
        InstanceBootstrapToken(
            id=next_id(),
            instance_id=iid,
            token_hash=hash_bootstrap_token(token),
            expires_at=expires_at,
        )
    )
    await db.commit()
    return BootstrapTokenOut(token=token, expires_at=expires_at, ttl_seconds=ttl)
