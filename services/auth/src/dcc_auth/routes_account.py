"""``DELETE /me`` — user-initiated hard-delete of their own account.

Three commitments shape this route:

* **Hard, not soft.** No grace period. ``DELETE FROM users WHERE id=?`` —
  the FK CASCADE chains (refresh_tokens, password_reset_tokens,
  email_verification_tokens, user_backup_codes — migration 0001 + 0006,
  dazu issued_credentials seit Migration 0014) do the bulk of the work;
  the avatar file is best-effort unlinked here.
* **Widerruf vor der Kaskade.** Geräte-Zertifikate müssen widerrufen sein,
  *bevor* ``issued_credentials`` mitgelöscht wird — danach kennt niemand mehr
  die ``cert_id``, und ein Self-Host ließe das Gerät bis zu 365 Tage weiter
  als das gelöschte Konto herein. Der Grabstein in ``revoked_credentials``
  hängt an keinem FK und trägt den Widerruf über die Löschung hinaus.
* **Cross-service first.** chat-gateway owns guild memberships, messages
  and presence — those rows must go *before* we delete the auth-side row,
  otherwise a half-deleted user becomes an unreferenced ``user_id`` in
  chat that nobody can ever clean up. If the chat purge fails we rollback
  and surface 503; the user stays logged-in and can retry.
* **Operator-gated.** Without ``INTERNAL_SERVICE_SECRET`` set, auth has no
  way to authenticate to chat — fail-closed with an actionable message
  ("``deletion_disabled_no_internal_secret``") rather than half-deleting.

Audit: ``admin_audit_log`` row written with ``actor_id == target_id ==
user.id`` and ``action = "user.self_delete"``. The schema uses plain
``BigInteger`` (not FK) for both columns, so the audit row survives the
``DELETE`` and lets operators see "who self-deleted, when".
"""

from __future__ import annotations

import asyncio
import logging
from pathlib import Path
from typing import Annotated

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request, status
from sqlalchemy import delete, func, select

import dcc_auth.config as _config
from dcc_auth.db import SessionDep
from dcc_auth.models import AdminAuditLog, User, WebAuthnCredential
from dcc_auth.models_instances import RegisteredInstance
from dcc_auth.routes import _check_rate, _get_current_user
from dcc_auth.routes_instance_delete import _DELETE_REASON, soft_delete_instance
from dcc_auth.routes_suspended_instances import _get_redis, suspended_list_add
from dcc_auth.schemas import AccountDeleteIn
from dcc_auth.security import verify_password
from dcc_auth.snowflake import next_id

log = logging.getLogger(__name__)

router = APIRouter()


def _avatar_filesystem_path(user_id: int) -> Path:
    """Mirror of ``routes_avatar._avatar_path`` — re-derived locally so this
    module doesn't import from ``routes_avatar`` (avoids a routes-coupling
    knot when Pillow isn't installed in some narrow dev environment).
    """
    settings = _config.get_settings()
    return Path(settings.avatar_upload_dir) / f"{user_id}.webp"


async def _purge_chat_state(user_id: int) -> tuple[bool, str | None]:
    """Call chat-gateway ``POST /internal/users/{id}/purge``.

    Returns ``(ok, error_detail)``. ``error_detail`` is a short tag suitable
    for logging — never returned to the client (chat-side internal state
    isn't user info). Network errors → ``("network_error", repr(exc))``;
    non-2xx → ``("status_<code>", body[:200])``.
    """
    settings = _config.get_settings()
    secret = settings.internal_service_secret
    if not secret:
        return False, "no_internal_secret"
    url = (
        settings.chat_gateway_url.rstrip("/")
        + f"/internal/users/{user_id}/purge"
    )
    try:
        async with httpx.AsyncClient(
            timeout=settings.chat_gateway_purge_timeout_s
        ) as http:
            resp = await http.post(
                url,
                headers={"X-Pulse-Internal-Secret": secret},
            )
    except httpx.HTTPError as exc:
        return False, f"network_error:{type(exc).__name__}"
    if 200 <= resp.status_code < 300:
        return True, None
    return False, f"status_{resp.status_code}:{resp.text[:200]}"


@router.delete("/me", status_code=status.HTTP_204_NO_CONTENT)
async def delete_me(
    request: Request,
    payload: AccountDeleteIn,
    session: SessionDep,
    current: Annotated[User, Depends(_get_current_user)],
):
    """Hard-delete the calling user. Irreversible.

    Order of operations (failures short-circuit and return without touching DB):
      1. rate-limit (very tight — 3/hour by default).
      2. confirm_username must match the *current* username exactly.
      3. password verification (off the event loop — argon2 is CPU-bound).
      4. second-factor verification when the account has any MFA factor
         (``totp_enabled`` OR at least one registered passkey).
      5. chat-gateway purge — on failure, rollback (no DB writes yet) and 503.
      6. avatar file unlink (best-effort).
      7. Geräte-Zertifikate widerrufen (Grabstein + ``revoked_at``) — muss vor
         Schritt 8 liegen, weil die Kaskade die Zeilen sonst mitnimmt.
      8. ``DELETE FROM users WHERE id = current.id`` — FK CASCADE cleans the
         child tables atomically.
      9. audit-log insert with ``actor_id == target_id``.
     10. commit, Redis-Sperrliste beschicken, 204.
    """
    settings = _config.get_settings()
    await _check_rate(request, "account_delete", settings.rate_limit_account_delete)

    # Operator hint: with no internal secret we cannot purge chat-side. Bail
    # *before* asking for password / 2FA so the user doesn't waste a code on
    # an op that will never succeed.
    if not settings.internal_service_secret:
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="deletion_disabled_no_internal_secret",
        )

    if payload.confirm_username != current.username:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST, detail="username_mismatch"
        )

    pw_ok = await asyncio.to_thread(
        verify_password, payload.password, current.password_hash
    )
    if not pw_ok:
        raise HTTPException(
            status.HTTP_401_UNAUTHORIZED, detail="invalid credentials"
        )

    # Second-factor gate: required whenever the account has ANY MFA factor —
    # TOTP *or* at least one registered passkey. A passkey-only account
    # (totp_enabled=False) still gates /login via the methods list in
    # routes.py, so irreversible self-deletion must demand the same proof of
    # possession. No interactive passkey challenge is feasible on a single
    # REST call, so a passkey-only account proves itself with a backup code —
    # ``_consume_second_factor`` already routes the backup-code path.
    has_passkey = await session.scalar(
        select(func.count())
        .select_from(WebAuthnCredential)
        .where(WebAuthnCredential.user_id == current.id)
    )
    if current.totp_enabled or has_passkey:
        # Lazy import — avoids a routes_account ↔ routes_totp cycle and
        # mirrors how routes_totp itself sources its login-second-step logic.
        from dcc_auth.routes_totp import _consume_second_factor

        ok = await _consume_second_factor(
            session, current, code=payload.code, backup_code=payload.backup_code
        )
        if not ok:
            # Don't commit any backup-code stamp — _consume_second_factor
            # mutates on success only, so a failed call leaves no trace.
            raise HTTPException(
                status.HTTP_401_UNAUTHORIZED, detail="invalid code"
            )

    # Cross-service purge MUST land before we touch our own row. If it fails
    # we rollback (the only pending change is the maybe-consumed backup code
    # row.used_at stamp; rollback drops it so the user can retry).
    user_id = current.id
    username_snapshot = current.username  # for audit after row is deleted
    ok, err = await _purge_chat_state(user_id)
    if not ok:
        await session.rollback()
        log.warning(
            "chat-gateway purge failed for self-delete user_id=%s detail=%s",
            user_id,
            err,
        )
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="chat_gateway_purge_failed",
        )

    # Avatar file cleanup — best-effort. The route-side avatar_url is a URL
    # path, not a filesystem path, but the on-disk filename is deterministic
    # (``<user_id>.webp``) so we can derive it without parsing the URL.
    try:
        _avatar_filesystem_path(user_id).unlink(missing_ok=True)
    except OSError as exc:
        log.info("avatar cleanup failed for user_id=%s: %s", user_id, exc)

    # Eigene Instanzen (VPS + App-Host) soft-deleten, BEVOR die User-Zeile
    # fällt: die Registry-Zeile überlebt per SET NULL (Worker-ID-Reservierung
    # + Kill-Switch), aber Memberships/Tokens/Telefonbuch müssen wie bei der
    # Owner-Löschung mit abgeräumt werden — geteilter Helper. Ohne diesen
    # Schritt blieben Mitglieder-Kacheln und ein erreichbarer Zombie-Server
    # zurück; vor Migration 0043 scheiterte das Konto-Löschen hier sogar hart
    # an der FK-Verletzung.
    owned_instances = (
        await session.scalars(
            select(RegisteredInstance)
            .where(
                RegisteredInstance.registered_by == user_id,
                RegisteredInstance.status != "deleted",
            )
            .with_for_update()
        )
    ).all()
    for inst in owned_instances:
        await soft_delete_instance(session, inst)
    deleted_instance_ids = [inst.id for inst in owned_instances]

    # Geräte-Zertifikate widerrufen, BEVOR die User-Zeile fällt. Der FK
    # Geräte-Zertifikate gibt es seit dem 2026-08-28 nicht mehr. Hier stand
    # deshalb ein Widerruf samt Grabstein: Ein Zertifikat lebte bis zu 365 Tage
    # und war nach dem Löschen des Kontos nicht mehr zurückzuziehen, weil
    # niemand seine Kennung mehr kannte.
    #
    # Mit dem Ticket-Weg löst sich das von selbst: Ein Ticket verlangt eine
    # gültige Cloud-Sitzung, und die stirbt mit der Nutzerzeile. Bestehende
    # Self-Host-Sitzungen laufen binnen einer Stunde ab.

    # Hard-delete. FK ON DELETE CASCADE handles the four child tables.
    await session.execute(delete(User).where(User.id == user_id))

    # Audit row — actor == target so operators can see self-vs-admin in
    # the same table. payload carries the username snapshot so a later
    # admin lookup doesn't need to cross-reference the (now gone) row.
    session.add(
        AdminAuditLog(
            id=next_id(),
            actor_id=user_id,
            action="user.self_delete",
            target_id=user_id,
            payload={"username": username_snapshot},
        )
    )

    await session.commit()

    # Erst nach dem Commit in die Redis-Sperrliste: ein Rollback (etwa an der
    # Instanz-Soft-Löschung) darf keinen Widerruf melden, den es nicht gibt.
    # Bleibt Redis stumm, trägt der Grabstein — der CRL-Endpunkt füllt ein
    # leeres ZSET aus der Datenbank nach.

    # Kill-Switch-Cache für gelöschte Instanzen invalidieren (nach dem Commit,
    # analog delete_my_instance): ein noch laufender Container sieht sich beim
    # nächsten Poll auf der Suspend-Liste und stellt den Betrieb ein.
    if deleted_instance_ids:
        redis = await _get_redis(request)
        if redis is not None:
            for iid in deleted_instance_ids:
                await suspended_list_add(redis, iid, _DELETE_REASON)
    return None
