"""Signal-Relay-Routen des Direktpfads (Plan ``2026-07-09-direct-path-webrtc``, Phase 3).

* ``WS /selfhost/directory/ws`` — der Klingeldraht der Server-App. Erste
  Nachricht MUSS die Auth sein (``{"instance_id", "token"}``, Relay-Token wie
  beim Heartbeat); danach empfängt die App Offers und schickt Answers.
* ``POST /me/instances/{id}/direct-offer`` — Client legt einen WebRTC-Offer
  hinein und bekommt die Answer zurück (Long-Poll, Timeout → 504). Session-
  und membership-gated wie der Telefonbuch-Lookup (404 gegen Existence-Leak).
"""

from __future__ import annotations

import asyncio
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Request, WebSocket, status
from pydantic import BaseModel, ConfigDict, Field
from starlette.websockets import WebSocketDisconnect

from dcc_auth.config import get_settings
from dcc_auth.db import SessionDep
from dcc_auth.direct_signal import InstanceOffline, OfferTimeout, hub
from dcc_auth.models_instances import UserInstanceMembership
from dcc_auth.routes import _check_rate
from dcc_auth.routes_admin_instances import _require_cloud
from dcc_auth.routes_instance_applications import _require_user
from dcc_auth.routes_selfhost_directory import _authed_instance

router = APIRouter(tags=["self-host"], dependencies=[Depends(_require_cloud)])

_AUTH_TIMEOUT_S = 5.0
_OFFER_TIMEOUT_S = 10.0
_MAX_SDP_LEN = 32_768


class DirectOfferIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    sdp: Annotated[str, Field(min_length=1, max_length=_MAX_SDP_LEN)]


class DirectOfferOut(BaseModel):
    sdp: str


@router.websocket("/selfhost/directory/ws")
async def directory_ws(ws: WebSocket, db: SessionDep) -> None:
    """Klingeldraht der Server-App: Auth-Frame, dann Offer/Answer-Verkehr."""
    await ws.accept()
    try:
        first = await asyncio.wait_for(ws.receive_json(), _AUTH_TIMEOUT_S)
    except (TimeoutError, WebSocketDisconnect):
        await ws.close(code=4001)
        return
    instance_id = first.get("instance_id")
    token = first.get("token")
    if not isinstance(instance_id, str) or not isinstance(token, str):
        await ws.close(code=4001)
        return
    try:
        inst = await _authed_instance(db, instance_id, token)
    except HTTPException:
        await ws.close(code=4001)
        return

    hub.register(inst.id, ws)
    await ws.send_json({"t": "ready"})
    try:
        while True:
            msg = await ws.receive_json()
            if (
                msg.get("t") == "answer"
                and isinstance(msg.get("connection_id"), str)
                and isinstance(msg.get("sdp"), str)
                and len(msg["sdp"]) <= _MAX_SDP_LEN
            ):
                hub.resolve_answer(msg["connection_id"], msg["sdp"])
            # Unbekannte Frames werden ignoriert (vorwärtskompatibel).
    except WebSocketDisconnect:
        pass
    finally:
        hub.unregister(inst.id, ws)


@router.post("/me/instances/{instance_id}/direct-offer", response_model=DirectOfferOut)
async def direct_offer(
    instance_id: str, body: DirectOfferIn, request: Request, db: SessionDep
) -> DirectOfferOut:
    """WebRTC-Offer an die Server-App durchreichen, Answer zurückgeben."""
    settings = get_settings()
    await _check_rate(request, "directory_offer", settings.rate_limit_directory_offer)
    user = await _require_user(request, db)

    try:
        iid = int(instance_id)
    except ValueError:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="not found")
    membership = await db.get(UserInstanceMembership, (user.id, iid))
    if membership is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="not found")

    try:
        answer = await hub.relay_offer(iid, body.sdp, _OFFER_TIMEOUT_S)
    except InstanceOffline:
        raise HTTPException(status.HTTP_409_CONFLICT, detail="instance not connected")
    except OfferTimeout:
        raise HTTPException(status.HTTP_504_GATEWAY_TIMEOUT, detail="no answer from instance")
    return DirectOfferOut(sdp=answer)
