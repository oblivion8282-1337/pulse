"""Schemas + helpers for the complaint (abuse report) endpoints.

Split out of ``routes_complaints.py`` to keep that module under the size policy.
Holds the Pydantic request/response models, the operator-email lookup (a
RegisteredInstance carries no contact address itself — it lives on the approved
InstanceApplication), and the per-page list enrichment.
"""

from __future__ import annotations

from datetime import datetime
from typing import Annotated

from pydantic import BaseModel, EmailStr, Field
from sqlalchemy import select

from dcc_auth.db import SessionDep
from dcc_auth.models import User
from dcc_auth.models_instances import Complaint, InstanceApplication, RegisteredInstance

VALID_STATUSES = {"new", "acknowledged", "forwarded", "resolved"}


# ---------------------------------------------------------------------------
# Schemas
# ---------------------------------------------------------------------------


class ComplaintCreate(BaseModel):
    body: Annotated[str, Field(min_length=10, max_length=5000)]
    target_url: Annotated[str | None, Field(default=None, max_length=500)] = None
    target_instance_id: int | None = None
    target_user_id: int | None = None
    submitter_email: EmailStr | None = None


class ComplaintOut(BaseModel):
    id: str
    status: str
    submitted_at: datetime
    body: str
    target_url: str | None = None
    target_instance_id: str | None = None
    target_user_id: str | None = None
    submitter_email: str | None = None
    resolution_note: str | None = None
    resolved_at: datetime | None = None
    # Forward audit trail.
    forwarded_at: datetime | None = None
    forwarded_to_email: str | None = None
    forward_notice: str | None = None
    # Enrichment (admin-only context, resolved per page — never persisted here).
    target_instance_hostname: str | None = None
    operator_email: str | None = None
    target_username: str | None = None

    @classmethod
    def from_row(
        cls,
        row: Complaint,
        *,
        instance_hostname: str | None = None,
        operator_email: str | None = None,
        target_username: str | None = None,
    ) -> ComplaintOut:
        return cls(
            id=str(row.id),
            status=row.status,
            submitted_at=row.submitted_at,
            body=row.body,
            target_url=row.target_url,
            target_instance_id=(
                str(row.target_instance_id) if row.target_instance_id is not None else None
            ),
            target_user_id=(
                str(row.target_user_id) if row.target_user_id is not None else None
            ),
            submitter_email=row.submitter_email,
            resolution_note=row.resolution_note,
            resolved_at=row.resolved_at,
            forwarded_at=row.forwarded_at,
            forwarded_to_email=row.forwarded_to_email,
            forward_notice=row.forward_notice,
            target_instance_hostname=instance_hostname,
            operator_email=operator_email,
            target_username=target_username,
        )


class ForwardIn(BaseModel):
    notice_text: Annotated[str, Field(min_length=1, max_length=5000)]


class ForwardResult(BaseModel):
    id: str
    status: str
    # Whether a notice email was actually dispatched to the operator. False when
    # no operator contact is on file or SMTP isn't configured — the status is
    # still advanced so the admin's decision is recorded, but the UI can warn.
    email_sent: bool
    email_error: str | None = None
    forwarded_to_email: str | None = None


class ResolveIn(BaseModel):
    resolution_note: str


# ---------------------------------------------------------------------------
# Operator lookup + list enrichment
# ---------------------------------------------------------------------------


async def resolve_operator(
    session: SessionDep, instance_id: int | None
) -> tuple[str | None, str | None]:
    """Return ``(hostname, operator_email)`` for a registered instance.

    Either element is ``None`` when unavailable (no instance row / no approved
    application with a contact email). The operator address lives on the
    approved ``InstanceApplication``, not on ``RegisteredInstance``.
    """
    if instance_id is None:
        return None, None
    instance = await session.get(RegisteredInstance, instance_id)
    hostname = instance.hostname if instance is not None else None
    app = (
        await session.execute(
            select(InstanceApplication)
            .where(InstanceApplication.approved_instance_id == instance_id)
            .order_by(InstanceApplication.created_at.desc())
        )
    ).scalars().first()
    operator_email = app.contact_email if app is not None else None
    return hostname, operator_email


async def enrich_complaints(
    session: SessionDep, rows: list[Complaint]
) -> list[ComplaintOut]:
    """Map a page of complaints to enriched output.

    Adds human-readable context — instance hostname, the operator's contact
    email (so the admin sees whether forwarding is possible), and the reported
    user's name. Batched per page via ``IN`` queries — no N+1.
    """
    instance_ids = {r.target_instance_id for r in rows if r.target_instance_id is not None}
    user_ids = {r.target_user_id for r in rows if r.target_user_id is not None}

    hostnames: dict[int, str] = {}
    operator_emails: dict[int, str] = {}
    usernames: dict[int, str] = {}

    if instance_ids:
        for inst in (
            await session.execute(
                select(RegisteredInstance).where(RegisteredInstance.id.in_(instance_ids))
            )
        ).scalars():
            hostnames[inst.id] = inst.hostname
        for app in (
            await session.execute(
                select(InstanceApplication).where(
                    InstanceApplication.approved_instance_id.in_(instance_ids)
                )
            )
        ).scalars():
            # First seen wins; multiple approved apps per instance is not expected.
            operator_emails.setdefault(app.approved_instance_id, app.contact_email)
    if user_ids:
        for u in (
            await session.execute(select(User).where(User.id.in_(user_ids)))
        ).scalars():
            usernames[u.id] = u.username

    return [
        ComplaintOut.from_row(
            r,
            instance_hostname=hostnames.get(r.target_instance_id),
            operator_email=operator_emails.get(r.target_instance_id),
            target_username=usernames.get(r.target_user_id),
        )
        for r in rows
    ]
