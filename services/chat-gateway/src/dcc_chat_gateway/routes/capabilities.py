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

from dcc_chat_gateway import config as chat_config
from dcc_chat_gateway.db import SessionDep
from dcc_chat_gateway.models import ChatSettings
from dcc_chat_gateway.schemas import CapabilitiesOut
from dcc_chat_gateway.security import CurrentUser

router = APIRouter()


def _upload_policy() -> dict[str, object]:
    """Instance-level upload-surface policy, sourced from env (not the DB row).

    Cloud-only restrictions; a self-host reports the permissive values because
    the gates in attachments.py / the dropbox router never fire there. Purely
    a UI hint — the server enforces the same rules independently."""
    settings = chat_config.get_settings()
    if settings.pulse_instance_mode != "cloud":
        return {
            "dm_attachments_enabled": True,
            "dropbox_enabled": True,
            "attachment_mime_prefixes": [],
        }
    return {
        "dm_attachments_enabled": settings.cloud_dm_attachments_enabled,
        "dropbox_enabled": settings.cloud_dropbox_enabled,
        "attachment_mime_prefixes": settings.cloud_attachment_mime_prefix_list,
    }


@router.get("/capabilities", response_model=CapabilitiesOut)
async def get_capabilities(session: SessionDep, _current: CurrentUser):
    row = await session.get(ChatSettings, 1)
    if row is None:
        # Singleton missing would be a migration mismatch — fall back to
        # the locked-down defaults that match the migrations. Inverting
        # ``allow_guild_creation`` to false keeps a missing row from
        # accidentally re-enabling "anyone can create a Server" on a
        # broken deploy.
        return CapabilitiesOut(
            allow_guild_creation=False,
            allow_member_invites=True,
            locked=False,
            guild_sound_max_size_bytes=524288,
            hq_bitrate_min_kbps=1000,
            hq_bitrate_max_kbps=10000,
            hq_fps_min=1,
            hq_fps_max=360,
            hq_resolution_max="Native",
            ns_bitrate_min_kbps=1000,
            ns_bitrate_max_kbps=10000,
            ns_fps_min=1,
            ns_fps_max=240,
            ns_resolution_max="native",
            cam_resolution_max="720p",
            cam_fps_max=30,
            **_upload_policy(),
        )
    # The row carries the DB-backed flags; the upload policy comes from env, so
    # it is merged on top rather than read via from_attributes.
    return CapabilitiesOut.model_validate(row).model_copy(update=_upload_policy())
