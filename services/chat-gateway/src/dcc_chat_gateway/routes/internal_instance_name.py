"""Server-Name über das interne Geheimnis lesen/setzen — für die Server-App.

Die Server-App (Electron) hat kein Admin-Konto auf ihrem eigenen Server, aber
Zugriff auf ``INTERNAL_SERVICE_SECRET`` (allinone: ``podman exec`` in den
Container; nativ: die Datei im Datenverzeichnis). Von außen ist ``/internal/*``
gesperrt (Caddy/nginx), und ``_check_internal_secret`` bremst und vergleicht
in konstanter Zeit. Setzen wirkt wie ``PATCH /admin/permissions`` mit
``instance_name``: speichern, verbundene Clients informieren, Cloud melden.
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Header, Request
from pydantic import BaseModel, ConfigDict, Field

from dcc_chat_gateway.db import SessionDep
from dcc_chat_gateway.instance_name import melde_im_hintergrund, normalisiere, verteile
from dcc_chat_gateway.routes.admin import _chat_settings
from dcc_chat_gateway.routes.internal import _check_internal_secret

router = APIRouter()


class InstanceNameIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    # 60 wie ``PermissionsPatch.instance_name``; leer = zurücksetzen.
    name: Annotated[str, Field(max_length=60)] | None = None


class InstanceNameOut(BaseModel):
    name: str | None


@router.get("/internal/instance-name", response_model=InstanceNameOut)
async def lies_instance_name(
    request: Request,
    session: SessionDep,
    x_pulse_internal_secret: Annotated[str | None, Header()] = None,
) -> InstanceNameOut:
    _check_internal_secret(request, x_pulse_internal_secret)
    row = await _chat_settings(session)
    return InstanceNameOut(name=row.instance_name)


@router.put("/internal/instance-name", response_model=InstanceNameOut)
async def setze_instance_name(
    body: InstanceNameIn,
    request: Request,
    session: SessionDep,
    x_pulse_internal_secret: Annotated[str | None, Header()] = None,
) -> InstanceNameOut:
    _check_internal_secret(request, x_pulse_internal_secret)
    row = await _chat_settings(session)
    neu = normalisiere(body.name)
    if neu != row.instance_name:
        row.instance_name = neu
        await session.commit()
        await session.refresh(row)
        await verteile(request, row)
        melde_im_hintergrund(row.instance_name)
    return InstanceNameOut(name=row.instance_name)
