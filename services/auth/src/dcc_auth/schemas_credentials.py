"""Pydantic schemas for the /credentials/* endpoints (DE 11 Block 1.C)."""

from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, Field


class CredentialIssueRequest(BaseModel):
    """Body for POST /credentials/issue."""

    device_pubkey: str = Field(..., min_length=1)
    device_label: str = Field(..., min_length=1, max_length=64)
    acr_values: str | None = None


class CredentialIssueResponse(BaseModel):
    """Response for POST /credentials/issue."""

    cert: str


class CredentialDevice(BaseModel):
    """One active credential as shown in the device list."""

    cert_id: str
    device_label: str
    issued_at: datetime
    expires_at: datetime
    has_backup: bool = False


class CredentialListResponse(BaseModel):
    """Response for GET /credentials/list."""

    devices: list[CredentialDevice]
