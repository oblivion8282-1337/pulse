"""Heim-Server läuft / läuft nicht / heißt jetzt so — an jedes Mitglied.

Publiziert von auth-svc (``instance_status.py``) auf ``user:events``, je
Mitglied einmal (Routing über ``_target_user_id``). Die Server-Leiste blendet
einen gestoppten Heim-Server aus und zeigt den Anzeigenamen statt der
Relay-Adresse; ohne dieses Ereignis sähe sie beides erst beim nächsten Laden
von ``/me/instances``.
"""

from __future__ import annotations

from typing import Literal

from dcc_shared.events._base import _EventBase


class InstanceStatusData(_EventBase):
    instance_id: str
    online: bool
    anzeigename: str | None = None


class InstanceStatusEvent(_EventBase):
    """``op="instance_status"`` — Online-Zustand oder Name hat sich geändert."""

    op: Literal["instance_status"] = "instance_status"
    data: InstanceStatusData
