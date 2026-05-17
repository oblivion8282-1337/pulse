"""Read-only view of server-wide permission flags for every authenticated user.

The admin panel writes to ``/admin/permissions``; this endpoint lets the
*frontend of every user* gate its UI on the same flags (hide the create-
guild button when ``allow_guild_creation=false``, etc.).

Not admin-gated — the flags themselves aren't sensitive. Per-user
elevations (is_admin, guild ownership) are applied client-side on top
of these values.

Changes are pushed live: routes/admin.py::patch_permissions publishes a
``permissions_updated`` envelope on guild:events, which chat-gateway
broadcasts to every connected WS so clients can refetch.
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, status

from dcc_chat_gateway.db import SessionDep
from dcc_chat_gateway.models import ChatSettings
from dcc_chat_gateway.schemas import PermissionsOut
from dcc_chat_gateway.security import CurrentUser

router = APIRouter()


@router.get("/capabilities", response_model=PermissionsOut)
async def get_capabilities(session: SessionDep, _current: CurrentUser):
    row = await session.get(ChatSettings, 1)
    if row is None:
        # Singleton missing would be a migration mismatch — fall back to
        # the historical "anyone can" defaults rather than 500ing the UI.
        return PermissionsOut(allow_guild_creation=True, allow_member_invites=True)
    return row
