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
    iat: int
    exp: int


class ProfileUpdateRequest(BaseModel):
    display_name: Annotated[str | None, Field(default=..., max_length=64)] = None
    avatar_hash: Annotated[str | None, Field(default=..., max_length=64)] = None
    profile_color: Annotated[str | None, Field(default=..., max_length=32)] = None


class UsernameChangeRequest(BaseModel):
    new_username: Annotated[str, Field(pattern=USERNAME_PATTERN)]


class UsernameChangeResponse(BaseModel):
    success: bool
    reserved_until: datetime