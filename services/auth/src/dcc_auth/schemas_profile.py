"""Pydantic schemas for profile-statement and profile-update endpoints (Block 1.D)."""

from __future__ import annotations

from datetime import datetime
from typing import Annotated

from pydantic import BaseModel, Field

from dcc_auth.schemas import USERNAME_PATTERN


class ProfileStatement(BaseModel):
    statement_id: str
    user_id: str
    username: str
    display_name: str | None = None
    avatar_hash: str | None = None
    profile_color: str | None = None
    profile_color_secondary: str | None = None
    profile_gradient_angle: int | None = None
    iat: int
    exp: int


class ProfileUpdateRequest(BaseModel):
    # avatar_hash is intentionally NOT writable here: it must only ever be set
    # by POST /me/avatar, which derives it from the SHA-256 of the actually
    # uploaded+processed image. Accepting it from the client would let anyone
    # point their profile at an arbitrary by-hash blob (impersonation), since
    # the by-hash avatar store is anonymously readable.
    display_name: Annotated[str | None, Field(default=..., max_length=64)] = None
    # Nur Hex-Farben (#rgb/#rgba/#rrggbb/#rrggbbaa): der Wert landet im Client
    # in ``style="color: …"`` — freie Strings könnten dort weitere
    # CSS-Deklarationen einschleusen (";font-size:…").
    profile_color: Annotated[
        str | None,
        Field(default=..., pattern=r"^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$"),
    ] = None
    # Zweite Gradient-Farbe (Name-Verlauf profile_color → profile_color_secondary).
    # Exakt parallel zu profile_color: gleiche Hex-Validierung, gleicher
    # ``default=...``-Sentinel, damit ``model_fields_set`` zwischen "nicht
    # gesendet" und "auf null gesetzt" unterscheiden kann.
    profile_color_secondary: Annotated[
        str | None,
        Field(default=..., pattern=r"^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$"),
    ] = None
    # Verlaufs-Richtung in Grad (0–360, CSS-linear-gradient-Winkel). Integer →
    # kein CSS-Injection-Risiko wie bei den Farb-Strings. ``default=...``-Sentinel
    # wieder, damit "nicht gesendet" ≠ "auf null gesetzt".
    profile_gradient_angle: Annotated[int | None, Field(default=..., ge=0, le=360)] = None


class UsernameChangeRequest(BaseModel):
    new_username: Annotated[str, Field(pattern=USERNAME_PATTERN)]


class UsernameChangeResponse(BaseModel):
    success: bool
    reserved_until: datetime