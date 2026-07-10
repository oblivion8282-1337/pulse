"""Entscheidung über einen Hosting-Antrag — Zustellung an den Antragsteller.

Publiziert von auth-svc auf ``user:events`` (Direct-Delivery an genau einen
User, Routing über ``_target_user_id``). Ohne dieses Ereignis erfuhr der
Antragsteller von einer Genehmigung erst beim nächsten 90-Sekunden-Poll.

Wire-Shape wie ``mention_added``: ``{op, data}``, absichtlich klein — der
Client lädt die Antragsliste danach über REST nach. Der Payload nennt keinen
Antrags-Inhalt, nur Art und Ausgang.
"""

from __future__ import annotations

from typing import Literal

from dcc_shared.events._base import _EventBase


class ApplicationDecidedData(_EventBase):
    # ``app_host`` = Freischaltung fürs Hosten auf dem eigenen Gerät,
    # ``instance`` = klassischer Self-Host-Antrag (eigener VPS).
    kind: Literal["app_host", "instance"]
    status: Literal["approved", "rejected"]
    rejection_reason: str | None = None


class ApplicationDecidedEvent(_EventBase):
    """``op="application_decided"`` — der Admin hat entschieden."""

    op: Literal["application_decided"] = "application_decided"
    data: ApplicationDecidedData
