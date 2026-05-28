"""Audit-log write helper for the chat-gateway.

``write_audit_log`` is the single insertion point for every moderation action
that must be recorded in ``chat.mod_audit_log``.  The table is append-only —
there is intentionally **no update or delete path** for audit entries.

Action-type strings in use (callers extend this list as needed):
  * ``report_resolved``   — report closed as "action taken"
  * ``report_dismissed``  — report closed as "no action"

Future callers (Phase 4) will add:
  * ``ban``               — member banned
  * ``kick``              — member kicked
  * ``message_delete``    — moderator-deleted message
  * ``role_change``       — role permission edit
  * ``permission_change`` — channel overwrite edit
"""

from __future__ import annotations

from sqlalchemy.ext.asyncio import AsyncSession

from dcc_chat_gateway.models import ModAuditLog
from dcc_chat_gateway.snowflake import next_id


async def write_audit_log(
    session: AsyncSession,
    *,
    guild_id: int,
    actor_user_id: int,
    action_type: str,
    target_kind: str | None = None,
    target_id: int | None = None,
    payload: dict | None = None,
) -> ModAuditLog:
    """Insert an immutable audit-log entry and flush it to the session.

    ``flush()`` (not ``commit()``) is used so that callers can include the
    insert in a larger transaction.  The caller is responsible for committing.

    Parameters
    ----------
    session:
        Active async SQLAlchemy session.
    guild_id:
        The guild this action belongs to.
    actor_user_id:
        The user who performed the action.
    action_type:
        Free-text discriminator (see module docstring for the canonical list).
    target_kind:
        ``"user"`` | ``"channel"`` | ``"role"`` | ``"message"`` — or ``None``
        when the action has no single target.
    target_id:
        Snowflake ID of the target object, or ``None``.
    payload:
        Opaque JSON dict with action-specific context (old/new values, reasons,
        linked report IDs, …).  Never ``None``-checked by the caller — the
        column is nullable at DB level.
    """
    entry = ModAuditLog(
        id=next_id(),
        guild_id=guild_id,
        actor_user_id=actor_user_id,
        action_type=action_type,
        target_kind=target_kind,
        target_id=target_id,
        payload=payload,
    )
    session.add(entry)
    await session.flush()
    return entry


__all__ = ["write_audit_log"]
