"""Dropbox storage channel: per-guild file/folder storage with quota + trash.

Revision ID: 0041_dropbox_storage
Revises: 0040_instance_name
Create Date: 2026-06-30 12:00:00

Two new tables:

* ``dropbox_configs`` — one row per guild that has activated the dropbox
  channel (singleton-per-guild). Holds the enabled toggle, total quota,
  per-file ceiling, trash-retention, and a cached ``used_bytes`` counter
  kept in sync by the API layer (no DB triggers — schema-version-clean,
  and at our scale a SUM over live rows is well under a millisecond).

* ``dropbox_files`` — metadata for every folder + file entry inside the
  dropbox. Folders carry size/content_type/storage_key NULL. Hierarchy
  is path-based (forward-slash separated relative paths normalized at
  write time). Soft-delete via ``deleted_at``; a periodic sweep hard-
  deletes rows whose ``deleted_at`` is older than the configured
  retention, and purges the corresponding MinIO object.

``channels.type == 2`` (dropbox) does not need a migration — the existing
SmallInteger column already accepts it; the type constant lives in
``dcc_chat_gateway.models.channels`` as ``CHANNEL_TYPE_DROPBOX``.
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision: str = "0041_dropbox_storage"
down_revision: str | None = "0040_instance_name"
branch_labels = None
depends_on = None

SCHEMA = "chat"


def upgrade() -> None:
    op.create_table(
        "dropbox_configs",
        sa.Column(
            "guild_id",
            sa.BigInteger(),
            sa.ForeignKey(f"{SCHEMA}.guilds.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        # Master-Schalter. False → der Kanal versteckt sich in der Sidebar
        # und die Routes liefern 404. Pro-Guild, weil Self-Hosts (single
        # guild pro Instanz) und Cloud unterschiedliche Defaults fahren
        # können — Self-Host könnte z.B. den Schalter per env-default
        # schon aktivieren.
        sa.Column(
            "enabled",
            sa.Boolean(),
            nullable=False,
            server_default=sa.text("true"),
        ),
        # Gesamt-Quota in Bytes. Default 5 GiB — komfortabel über dem
        # typischen "Bilder + ein paar PDFs"-Profil eines kleinen Servers
        # ohne einen Self-Host mit kleiner Disk in die Knie zu zwingen.
        sa.Column(
            "total_quota_bytes",
            sa.BigInteger(),
            nullable=False,
            server_default="5368709120",
        ),
        # Per-File-Cap. Default 100 MiB — deckt die meisten Clip-/RAW-
        # Workflows ab; harte Videos (>= 1 GiB) gehen extra in den
        # HQ-Streaming-Kanal (MediaMTX), nicht in die Ablage.
        sa.Column(
            "per_file_max_bytes",
            sa.BigInteger(),
            nullable=False,
            server_default="104857600",
        ),
        # Cached counter — bei jedem Upload/Delete/Restore inkrementiert
        # bzw. dekrementiert. Liest sich O(1) für die Sidebar-Quota-Anzeige
        # statt O(n) SUM pro WS-Ping. Quelle der Wahrheit beim Drift-Check
        # ist ``SUM(size_bytes) WHERE deleted_at IS NULL``.
        sa.Column(
            "used_bytes",
            sa.BigInteger(),
            nullable=False,
            server_default="0",
        ),
        # Soft-delete-Aufbewahrung. Default 30 Tage — genre-üblich und
        # deckt "Ups, falscher Ordner"-Wutausbrüche. Admin-konfigurierbar
        # via /guilds/{id}/dropbox/settings PATCH.
        sa.Column(
            "trash_retention_days",
            sa.SmallInteger(),
            nullable=False,
            server_default="30",
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        schema=SCHEMA,
    )

    op.create_table(
        "dropbox_files",
        sa.Column("id", sa.BigInteger(), primary_key=True, autoincrement=False),
        sa.Column(
            "guild_id",
            sa.BigInteger(),
            sa.ForeignKey(f"{SCHEMA}.guilds.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "channel_id",
            sa.BigInteger(),
            sa.ForeignKey(f"{SCHEMA}.channels.id", ondelete="CASCADE"),
            nullable=False,
        ),
        # Pfad innerhalb der Ablage, normalisiert: "" = root,
        # "screenshots" = ein Ordner, "screenshots/banner" = nested.
        # Niemals mit führendem oder abschließendem "/". Folder-Rows
        # tragen den Pfad OHNE trailing slash — der Name-Component ist
        # ``name``.
        sa.Column("parent_path", sa.Text(), nullable=False, server_default=""),
        # Basename des Eintrags. Max 255 Zeichen; auf Sonderzeichen wie
        # "/" wird im API-Layer geprüft (Splitting würde die Hierarchie
        # kompromittieren). Pfad-Injection ist damit reine UX-Frage.
        sa.Column("name", sa.Text(), nullable=False),
        # 0 = folder, 1 = file. Folder-Rows haben size/content_type/
        # storage_key NULL.
        sa.Column(
            "kind",
            sa.SmallInteger(),
            nullable=False,
            server_default="0",
        ),
        sa.Column("size_bytes", sa.BigInteger(), nullable=True),
        sa.Column("content_type", sa.Text(), nullable=True),
        # MinIO-Key im Schema ``dropbox/<guild_id>/<storage_path>``.
        # NULL für Folders und für bereits trash-gemerkte Einträge (das
        # MinIO-Objekt ist dann schon gepurged).
        sa.Column("storage_key", sa.Text(), nullable=True),
        # Version-Counter — Inkrement auf overwrite (gleicher Name, neuer
        # Inhalt). v1 ist die Initial-Version. Storage-Key enthält das
        # Suffix ``_v<n>`` so der Vorgänger-Minio-Objekt für Restore
        # erhalten bleibt.
        sa.Column("version", sa.SmallInteger(), nullable=False, server_default="1"),
        sa.Column("uploaded_by_id", sa.BigInteger(), nullable=False),
        sa.Column(
            "uploaded_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        # Soft-delete: deleted_at gesetzt → im Trash, nicht in Listings.
        # Hard-delete (purge MinIO + remove row) passiert durch den
        # periodischen Sweep nach ``trash_retention_days``.
        sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("deleted_by_id", sa.BigInteger(), nullable=True),
        sa.Column(
            "pinned",
            sa.Boolean(),
            nullable=False,
            server_default=sa.text("false"),
        ),
        schema=SCHEMA,
    )

    # Load-Patterns:
    #   - Listing eines Ordners → (guild_id, parent_path, deleted_at IS NULL)
    #   - Recent Activity   → (guild_id, uploaded_at DESC) where deleted_at IS NULL
    #   - Trash-Sweep       → (deleted_at) where deleted_at IS NOT NULL
    #   - Search            → (guild_id, name) where deleted_at IS NULL
    op.create_index(
        "ix_dropbox_files_guild_parent",
        "dropbox_files",
        ["guild_id", "parent_path"],
        schema=SCHEMA,
    )
    op.create_index(
        "ix_dropbox_files_channel",
        "dropbox_files",
        ["channel_id"],
        schema=SCHEMA,
    )
    op.create_index(
        "ix_dropbox_files_guild_uploaded_at",
        "dropbox_files",
        ["guild_id", "uploaded_at"],
        schema=SCHEMA,
    )
    op.create_index(
        "ix_dropbox_files_name_trgm",
        "dropbox_files",
        ["guild_id", "name"],
        schema=SCHEMA,
    )
    op.create_index(
        "ix_dropbox_files_trash_sweep",
        "dropbox_files",
        ["deleted_at"],
        schema=SCHEMA,
    )

    # Application-enforced uniqueness: ein Live-Eintrag pro
    # (guild_id, parent_path, name). Trash-Einträge dürfen denselben
    # (guild, parent, name) nochmal haben, weil der ursprüngliche Live-
    # Eintrag nach Hard-Delete verschwindet — sonst kann man eine Datei
    # nicht wiederherstellen, wenn der Name zwischenzeitlich neu belegt
    # wurde. Postgres + SQLite beide unterstützen partial unique indexes.
    op.execute(
        f"""
        CREATE UNIQUE INDEX uq_dropbox_files_live_name
            ON {SCHEMA}.dropbox_files (guild_id, parent_path, name)
            WHERE deleted_at IS NULL
        """
    )


def downgrade() -> None:
    op.execute(f"DROP INDEX IF EXISTS {SCHEMA}.uq_dropbox_files_live_name")
    op.drop_index("ix_dropbox_files_trash_sweep", table_name="dropbox_files", schema=SCHEMA)
    op.drop_index("ix_dropbox_files_name_trgm", table_name="dropbox_files", schema=SCHEMA)
    op.drop_index("ix_dropbox_files_guild_uploaded_at", table_name="dropbox_files", schema=SCHEMA)
    op.drop_index("ix_dropbox_files_channel", table_name="dropbox_files", schema=SCHEMA)
    op.drop_index("ix_dropbox_files_guild_parent", table_name="dropbox_files", schema=SCHEMA)
    op.drop_table("dropbox_files", schema=SCHEMA)
    op.drop_table("dropbox_configs", schema=SCHEMA)
