"""users-FKs im Instanz-Registry: Konto-Löschung darf nicht mehr blockieren

Bisher hatten vier FKs auf ``users.id`` KEIN ``ondelete`` (Postgres-Default
NO ACTION) — ``DELETE /me`` lief für jeden User mit registrierter Instanz
oder auch nur einem (abgelehnten) Self-Host-Antrag in eine FK-Verletzung
(HTTP 500), das Konto war unlöschbar.

Neu:
- ``registered_instances.registered_by`` → nullable + ``SET NULL``:
  die Zeile MUSS überleben (Worker-ID-Reservierung + Kill-Switch,
  s. routes_instance_delete-Docstring), nur der Owner-Link fällt weg.
- ``instance_applications.applicant_user_id`` → ``CASCADE``:
  Anträge sind personenbezogene Daten des Antragstellers (DSGVO).
- ``instance_applications.reviewed_by`` → ``SET NULL`` (Review-Historie bleibt).
- ``complaints.target_user_id`` → ``SET NULL`` (Beschwerde-Historie bleibt).

Revision ID: 0043_users_fk_ondelete
Revises: 0042_experimental_logs
Create Date: 2026-07-13
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision: str = "0043_users_fk_ondelete"
down_revision: str | None = "0042_experimental_logs"
branch_labels = None
depends_on = None

SCHEMA = "auth"

# (table, column, fk_name, ondelete)
_FKS: list[tuple[str, str, str, str]] = [
    (
        "registered_instances",
        "registered_by",
        "registered_instances_registered_by_fkey",
        "SET NULL",
    ),
    (
        "instance_applications",
        "applicant_user_id",
        "instance_applications_applicant_user_id_fkey",
        "CASCADE",
    ),
    (
        "instance_applications",
        "reviewed_by",
        "instance_applications_reviewed_by_fkey",
        "SET NULL",
    ),
    ("complaints", "target_user_id", "complaints_target_user_id_fkey", "SET NULL"),
]


def _recreate_fks(ondelete_for: dict[str, str | None]) -> None:
    for table, column, fk_name, ondelete in _FKS:
        op.drop_constraint(fk_name, table, schema=SCHEMA, type_="foreignkey")
        op.create_foreign_key(
            fk_name,
            table,
            "users",
            [column],
            ["id"],
            source_schema=SCHEMA,
            referent_schema=SCHEMA,
            ondelete=ondelete_for.get(fk_name, ondelete),
        )


def upgrade() -> None:
    op.alter_column(
        "registered_instances",
        "registered_by",
        existing_type=sa.BigInteger(),
        nullable=True,
        schema=SCHEMA,
    )
    _recreate_fks({})


def downgrade() -> None:
    # NULL-Owner-Zeilen (aus Konto-Löschungen) müssten für NOT NULL erst
    # bereinigt werden — Downgrade entfernt sie nicht, er scheitert dann laut.
    _recreate_fks({fk: None for _, _, fk, _ in _FKS})
    op.alter_column(
        "registered_instances",
        "registered_by",
        existing_type=sa.BigInteger(),
        nullable=False,
        schema=SCHEMA,
    )
