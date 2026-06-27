"""merge self_host_enabled + user_session_revoked_at

Branch-Punkt ab 0031_profile_gradient_angle: zwei parallele Köpfe
(0032_instance_relay_provisioning → 0033_user_self_host_enabled aus dem
Self-Host-Feature-Branch und 0032_user_session_revoked_at aus main). Reine
Merge-Revision — keine Schema-Änderung, beide Vorgänger decken disjunkte
Spalten ab und sind unabhängig anwendbar.

Why: alembic upgrade head schlug ohne Merge fehl (mehrere Heads), was bei
frischen Local-DBs die self_host_enabled-Spalte nicht anlegte und damit die
locked-card der App-Hosting-Section mit 500er abreißen ließ.

How to apply: läuft beim nächsten ``alembic upgrade head`` automatisch als
letzter Schritt nach beiden Vorgängern.
"""

from __future__ import annotations

from collections.abc import Sequence

revision: str = "0034_merge_heads"
down_revision: str | Sequence[str] | None = (
    "0033_user_self_host_enabled",
    "0032_user_session_revoked_at",
)
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass