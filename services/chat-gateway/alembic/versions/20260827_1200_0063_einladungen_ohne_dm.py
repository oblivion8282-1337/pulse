"""einladungen_ohne_dm — eine Schiene fuer Community-Einladungen

Community-Einladungen liefen bis hierher auf zwei Wegen: unter Freunden ueber
den ``community_invites``-Broker, der serverseitig eine DM im Namen des
Einladenden schrieb, und an Nicht-Freunde ueber
``community_invite_notifications`` (Inbox mit Annehmen/Ablehnen). Der erste Weg
ist mit Ende-zu-Ende-verschluesselten Direktnachrichten unmoeglich — der Server
haette dafuer den Schluessel des Einladenden gebraucht.

Diese Migration ruestet die Inbox-Tabelle so aus, dass sie BEIDE Wege traegt,
und uebernimmt die offenen Broker-Zeilen.

Bewusst NICHT hier: ``community_invites`` wird nicht gedroppt. Das passiert in
einer Folge-Migration nach erfolgreichem Deploy — dieselbe Vorsicht wie bei
``9999_drop_user_cloud_backup`` im auth-Service. Ein Rollback soll die alten
Daten noch vorfinden.

Ebenfalls bewusst nicht angefasst: ``guild_members``. An Mitgliedschaften
aendert diese Migration nichts, niemand verliert eine Community.

Revision ID: 0063_einladungen_ohne_dm
Revises: 0062_guild_directory
Create Date: 2026-08-27 12:00:00
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision: str = "0063_einladungen_ohne_dm"
down_revision: str | None = "0062_guild_directory"
branch_labels = None
depends_on = None

SCHEMA = "chat"
TABLE = "community_invite_notifications"


def upgrade() -> None:
    # --- 1. Neue Spalten -----------------------------------------------------
    op.add_column(TABLE, sa.Column("target_host", sa.String(255), nullable=True), schema=SCHEMA)
    op.add_column(TABLE, sa.Column("target_instance_id", sa.BigInteger(), nullable=True), schema=SCHEMA)
    op.add_column(TABLE, sa.Column("code", sa.Text(), nullable=True), schema=SCHEMA)
    op.add_column(TABLE, sa.Column("guild_name", sa.String(128), nullable=True), schema=SCHEMA)
    op.add_column(
        TABLE, sa.Column("expires_at", sa.DateTime(timezone=True), nullable=True), schema=SCHEMA
    )

    # --- 2. Entschiedene Zeilen raus, dann die status-Spalte ------------------
    # Ab jetzt ist die Existenz der Zeile der Zustand: Annehmen und Ablehnen
    # loeschen sie. Die Altlast an accepted/declined-Zeilen wuerde sonst als
    # offene Einladung in der Inbox auftauchen.
    op.execute(
        sa.text(f"DELETE FROM {SCHEMA}.{TABLE} WHERE status <> 'pending'")
    )

    # --- 3. Fremdschluessel auf guilds loesen --------------------------------
    # ``guild_id`` kann jetzt auf eine Community auf einem fremden Host zeigen,
    # fuer die es in der Cloud keine Zeile gibt. Das Aufraeumen beim
    # Community-Loeschen uebernimmt die Delete-Route von Hand.
    bind = op.get_bind()
    if bind.dialect.name == "postgresql":
        fks = sa.inspect(bind).get_foreign_keys(TABLE, schema=SCHEMA)
        for fk in fks:
            if fk.get("referred_table") == "guilds" and fk.get("name"):
                op.drop_constraint(fk["name"], TABLE, type_="foreignkey", schema=SCHEMA)

    op.drop_column(TABLE, "status", schema=SCHEMA)

    # --- 4. Indizes ----------------------------------------------------------
    # Bedingt: der status-Index fehlt in Datenbanken, die ueber ``create_all``
    # entstanden sind (Dev-Staende, Testlaeufe). Ein hartes DROP liesse die
    # Migration dort mit „index does not exist" abbrechen, obwohl nichts fehlt.
    vorhandene = {i["name"] for i in sa.inspect(bind).get_indexes(TABLE, schema=SCHEMA)}
    if "ix_community_invite_notifications_invitee_status" in vorhandene:
        op.drop_index(
            "ix_community_invite_notifications_invitee_status",
            table_name=TABLE,
            schema=SCHEMA,
        )
    op.create_index(
        "ix_community_invite_notifications_invitee", TABLE, ["invitee_user_id"], schema=SCHEMA
    )
    op.create_index(
        "ix_community_invite_notifications_expires", TABLE, ["expires_at"], schema=SCHEMA
    )

    # --- 5. Offene Broker-Zeilen uebernehmen ---------------------------------
    # Der Broker loescht seine Zeile beim Entscheiden, es liegen dort also nur
    # offene Einladungen. ``id`` wird uebernommen (beide Tabellen ziehen aus
    # demselben Snowflake-Generator, eine Kollision ist ausgeschlossen).
    op.execute(
        sa.text(
            f"""
            INSERT INTO {SCHEMA}.{TABLE}
                (id, guild_id, inviter_user_id, invitee_user_id,
                 target_host, target_instance_id, code, guild_name,
                 created_at, expires_at)
            SELECT ci.id, ci.target_guild_id, ci.inviter_id, ci.invitee_id,
                   ci.target_host, ci.target_instance_id, ci.code,
                   ci.target_guild_name, ci.created_at, ci.expires_at
              FROM {SCHEMA}.community_invites ci
             WHERE NOT EXISTS (
                   SELECT 1 FROM {SCHEMA}.{TABLE} n
                    WHERE n.guild_id = ci.target_guild_id
                      AND n.invitee_user_id = ci.invitee_id
             )
            """
        )
    )


def downgrade() -> None:
    bind = op.get_bind()
    vorhandene = {i["name"] for i in sa.inspect(bind).get_indexes(TABLE, schema=SCHEMA)}
    for name in (
        "ix_community_invite_notifications_expires",
        "ix_community_invite_notifications_invitee",
    ):
        if name in vorhandene:
            op.drop_index(name, table_name=TABLE, schema=SCHEMA)
    op.add_column(
        TABLE,
        sa.Column("status", sa.Text(), nullable=False, server_default="pending"),
        schema=SCHEMA,
    )
    op.create_index(
        "ix_community_invite_notifications_invitee_status",
        TABLE,
        ["invitee_user_id", "status"],
        schema=SCHEMA,
    )
    bind = op.get_bind()
    if bind.dialect.name == "postgresql":
        op.create_foreign_key(
            "community_invite_notifications_guild_id_fkey",
            TABLE,
            "guilds",
            ["guild_id"],
            ["id"],
            source_schema=SCHEMA,
            referent_schema=SCHEMA,
            ondelete="CASCADE",
        )
    for spalte in ("expires_at", "guild_name", "code", "target_instance_id", "target_host"):
        op.drop_column(TABLE, spalte, schema=SCHEMA)
