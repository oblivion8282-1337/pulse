"""User-facing Self-Hoster endpoints — Phase 2.2.

GET    /me/instances                    -- eigene registrierte Instanzen
POST   /me/instances/{id}/env-file            -- fertige .env (inkl. frischem Secret)
POST   /me/instances/{id}/bootstrap-token     -- One-Time-Installer-Token

Die Antrags-Endpoints (``/me/instance-applications``) leben seit dem vereinten
Antragssystem (Migration 0044) in ``routes_applications.py``; Beitritt, Austritt
und die Server-Präferenzen in ``routes_instance_membership.py`` (Größen-Policy).
"""

from __future__ import annotations

import asyncio
import secrets
from datetime import UTC, datetime, timedelta
from typing import Literal

from fastapi import APIRouter, HTTPException, Request, Response, status
from pydantic import BaseModel
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
    """Cloud-Gate (④) — sitzt nur auf ``generate_env_file``, und dort nur fuer
    ``origin == "app_host"``.

    **Einschraenkung 2026-08-27 (gemeldeter Fehler).** Das Flag ist durchweg ein
    APP-HOST-Begriff: ``_guard_app_host`` sperrt damit Doppelantraege, der
    Widerruf loescht es und suspendiert dabei genau die ``app_host``-Instanzen.
    ``_approve_vps`` setzt es deshalb nie (festgehalten in
    ``test_unified_applications``) — womit es fuer einen VPS-Eigentuemer nicht
    ein Gate war, sondern eine Mauer: der ``.env``-Download, also Schritt 1 des
    manuellen Compose-Wegs, war fuer die einzige Zielgruppe dieses Wegs
    dauerhaft zu. Der Absatz unten wusste das schon („Flag greift bei denen
    nie") und zog daraus nur den Schluss fuer den Mint. Sichtbar wurde es nie,
    weil die Oberflaeche jeden 403 als „schon heruntergeladen" auslegte.

    Den VPS-Fall deckt seither dasselbe wie den Bootstrap-Mint (s.u.), der
    dieselben Zugangsdaten liefert: Eigentuemer-Check plus eine vom Admin
    genehmigte, **aktive** Instanz — der Status wird dafuer jetzt ausdruecklich
    geprueft, vorher stand dort nur „nicht geloescht", eine suspendierte
    Instanz haette also frische Zugangsdaten ziehen koennen.

    Entscheidung 2026-07-13 (der frühere Docstring verlangte das Gate auch auf
    ``mint_bootstrap_token`` — das war veraltet, nicht der Code): Der
    Bootstrap-Mint ist bereits über den Owner-Check (``registered_by ==
    user.id``) plus eine vom Admin genehmigte, aktive Instanz gedeckt, und der
    Redeem verweigert nicht-aktive Instanzen. Die Server-App nutzt den Mint
    außerdem mit ``reset=true`` zur Crash-/Gerätewechsel-Recovery — ein
    ``self_host_enabled``-Gate dort würde App-Host-Owner nach einem Admin-
    Revoke+Re-Approve-Zyklus oder VPS-Owner (Flag greift bei denen nie)
    aussperren. Fuer App-Host-Instanzen bleibt
    das Flag am env-File-Download noetig, weil der jederzeit ein frisches
    ``client_secret`` rotieren kann und das Loeschen des Flags dort der
    Widerruf IST (s. CLAUDE.md „Self-Host-Approval-Flow")."""
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
    # Eigene Rolle auf DIESER Instanz. Die Liste beantwortet „mit welchen
    # Servern habe ich zu tun", nicht „welche gehören mir" — ein per Einladung
    # beigetretener Server steht mit ``member`` darin, damit er auf allen
    # Geräten in der Server-Leiste erscheint. Ohne dieses Feld kann die
    # Oberfläche Besitz und Mitgliedschaft nicht unterscheiden.
    role: Literal["owner", "member"]


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _instance_to_out(
    inst: RegisteredInstance,
    viewer_id: int,
    membership: UserInstanceMembership | None = None,
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
        # BEWUSST aus ``registered_by``, nicht aus ``membership.role``: die
        # Verwaltungs-Routen (env-file, bootstrap-token, DELETE) verriegeln
        # genau gegen dieses Feld. Eine Rollen-Spalte, die davon abwiche, ließe
        # die Oberfläche Knöpfe zeigen, die anschließend 404 laufen.
        role="owner" if inst.registered_by == viewer_id else "member",
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
    return [_instance_to_out(inst, user.id, membership) for inst, membership in rows]


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

    Nur der Eigentümer einer **aktiven** Instanz (404 statt 403 gegen
    Existence-Leak; bei ``origin == "app_host"`` zusaetzlich das
    ``self_host_enabled``-Flag, s. ``_require_self_host_enabled``). Anders als ein
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

    # Das Recht haengt an DIESER Instanz, nicht am Nutzer (s. Docstring):
    # gesperrt heisst gesperrt, und das Nutzer-Flag zaehlt nur dort, wo es
    # ueberhaupt etwas widerruft — bei App-Host-Instanzen.
    if inst.status != "active":
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            detail="Diese Instanz ist gesperrt — keine neuen Zugangsdaten",
        )
    if inst.origin == "app_host":
        _require_self_host_enabled(user)

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
            # Fuehrender Code, weil dieser Endpunkt DREI verschiedene 403
            # kennt (Sperre der Instanz, App-Host-Flag, diese Kollision) und
            # nur bei diesem einen „neu ausstellen" hilft. Die Oberflaeche las
            # frueher jeden 403 als „schon heruntergeladen" und bot einen
            # Ausweg an, der die anderen beiden Faelle nicht loesen konnte.
            # Der Prosa-Teil bleibt: er steht in Fehlerberichten und Logs.
            detail=(
                "already_provisioned: Dieser Server wurde bereits eingerichtet — "
                "neu ausstellen ist moeglich, der bisher laufende Server verliert "
                "dabei seinen Zugang"
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
