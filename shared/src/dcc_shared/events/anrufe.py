"""Anruf-Signalisierung (Übergabe P0, Anrufe-Epic B) — ephemeral, kein Gap-Fill.

Vier Ops, alle per ``publish_user_event`` an konkrete Teilnehmerkonten
gerichtet (Muster wie ``friend_request_received``). Die Nutzlasten sind
absichtlich inhaltsleer bis auf Identifikatoren: audio/video läuft nach
dem Annahme-Klick über LiveKit (``POST /call/token`` in voice-signaling),
nicht über diese Events.
"""

from typing import Literal

from pydantic import BaseModel, ConfigDict


class _AnrufEventBase(BaseModel):
    model_config = ConfigDict(extra="forbid")


class CallKlingeltEvent(_AnrufEventBase):
    """``op="call_klingelt"`` — an jeden weiteren Teilnehmer: es klingelt.
    ``video`` ist der Vorschau-Hinweis für den Klingel-Screen (der Initiator
    hat die Kamera an); der Medienweg selbst läuft über LiveKit."""

    op: Literal["call_klingelt"] = "call_klingelt"
    call_id: str
    art: str  # "dm" | "gruppe"
    channel_id: str
    einleiter_id: str
    video: bool = False


class CallAngenommenEvent(_AnrufEventBase):
    """``op="call_angenommen"`` — Teilnehmer X ist drin (Initiator stoppt
    Klingeln, Gruppenmitglieder sehen wer da ist)."""

    op: Literal["call_angenommen"] = "call_angenommen"
    call_id: str
    user_id: str


class CallAbgelehntEvent(_AnrufEventBase):
    """``op="call_abgelehnt"`` — Teilnehmer X hat ausdrücklich abgelehnt."""

    op: Literal["call_abgelehnt"] = "call_abgelehnt"
    call_id: str
    user_id: str


class CallEndeEvent(_AnrufEventBase):
    """``op="call_ende"`` — der Anruf ist vorbei; ``grund``: aufgelegt /
    abgelehnt / verpasst, ``dauer_sek`` nur bei einem laufenden Anruf.
    Der Klient räumt seine UI ab und spielt den Klingel-Ton aus."""

    op: Literal["call_ende"] = "call_ende"
    call_id: str
    grund: str
    dauer_sek: int = 0
