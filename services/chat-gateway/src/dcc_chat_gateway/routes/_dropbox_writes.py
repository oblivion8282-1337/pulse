"""Schreibwege der Ablage, die ein Rennen entscheiden müssen.

Drei Befunde des Bughunts vom 17.08.2026 haben dieselbe Wurzel: **prüfen, dann
ohne Absicherung schreiben** — zweimal Papierkorb bucht das Kontingent zweimal
ab, zweimal Wiederherstellen zweimal gut, zweimal derselbe Name endet als
unbehandelter 500er. Die gemeinsame Antwort steht hier: **der Schreibvorgang
selbst entscheidet, nicht die Vorprüfung.**

* Zustandswechsel (Papierkorb / Zurückholen) laufen als *bedingtes* UPDATE mit
  ``deleted_at IS NULL`` bzw. ``IS NOT NULL`` in der WHERE-Klausel. Genau eine
  der beiden Anfragen bekommt ``rowcount == 1`` — nur die bucht um, die andere
  sieht ihren eigenen 404.
* Namenskollisionen entscheidet der partielle Unique-Index aus Migration 0043;
  ``commit_or_conflict`` übersetzt seine ``IntegrityError`` in dieselbe 409,
  die die Vorprüfung im Normalfall liefert (Muster wie in
  ``dropbox_uploads.py::_finish_upload_locked``).

Sperrreihenfolge — warum das nicht verklemmen kann
--------------------------------------------------
Jeder kontingentwirksame Weg der Ablage (Mint, Abschluss, Papierkorb,
Wiederherstellen, Papierkorb leeren, Einstellungen) nimmt **genau eine**
Zeilensperre, und zwar immer als **erste**: die Konfigurationszeile der
Community über ``locked_config`` (``SELECT … FOR UPDATE``; auf SQLite ein
No-op, dort trägt die prozesslokale ``with_quota_lock``). Die Zeilen in
``dropbox_files`` werden **nicht** gesperrt — ihre Identitätsfrage beantwortet
das bedingte UPDATE. Wo es nur eine Sperre gibt, gibt es keine zweite, deren
Reihenfolge man vertauschen könnte, und ein Deadlock setzt mindestens zwei
über Kreuz gehaltene Sperren voraus. Weil dieselbe Konfigurationssperre vor
jeder Kontingentänderung steht, ist der Teilbaum innerhalb des Blocks stabil:
``SELECT`` und anschliessendes ``UPDATE`` darauf können sich nicht überholen.

Eigene Datei, weil ``routes/dropbox.py`` die 350-Zeilen-Grenze (PLAN.md §12.1)
längst überschreitet und nicht weiter wachsen soll.
"""

from __future__ import annotations

from datetime import datetime

from fastapi import HTTPException
from sqlalchemy import or_, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from dcc_chat_gateway.models import (
    DROPBOX_KIND_FILE,
    DROPBOX_KIND_FOLDER,
    DropboxConfig,
    DropboxFile,
)
from dcc_chat_gateway.routes._dropbox_helpers import (
    bump_used,
    locked_config,
    utc_now,
    with_quota_lock,
)

#: Obergrenze für eine Kaskade in einem Rutsch. Dieselbe Zahl wie beim
#: Papierkorb-Leeren; wer mehr in einem Ordner hat, leert ihn stufenweise.
MAX_CASCADE_ROWS = 10_000


# --- Pfad-Werkzeug ----------------------------------------------------


def self_path(entry: DropboxFile) -> str:
    """Vollständiger Pfad des Eintrags selbst (Elternpfad + Name)."""

    return f"{entry.parent_path}/{entry.name}" if entry.parent_path else entry.name


def like_prefix(path: str) -> str:
    """LIKE-Muster für „alles unterhalb von ``path``" — mit Maskierung.

    ``%`` und ``_`` sind in LIKE Platzhalter und in einem Ablage-Namen
    erlaubt. Unmaskiert risse der Ordner ``a_b`` beim Löschen den Inhalt des
    unbeteiligten ``axb`` mit — bei einer Kaskade wäre das Datenverlust. Der
    Rückstrich muss zum ``escape=``-Argument der Aufrufstelle passen."""

    escaped = path.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    return f"{escaped}/%"


def subtree_filter(guild_id: int, entry: DropboxFile):
    """WHERE-Bedingung für den Teilbaum unter ``entry`` (ohne ``entry``) —
    direkte Kinder und tiefere Nachkommen."""

    own = self_path(entry)
    return (
        DropboxFile.guild_id == guild_id,
        DropboxFile.id != entry.id,
        or_(
            DropboxFile.parent_path == own,
            DropboxFile.parent_path.like(like_prefix(own), escape="\\"),
        ),
    )


def _own_bytes(row: DropboxFile) -> int:
    """Kontingentwirksame Bytes einer Zeile. Ordner wiegen nichts."""

    return int(row.size_bytes or 0) if row.kind == DROPBOX_KIND_FILE else 0


# --- Kollisionen der Datenbank überlassen -----------------------------


async def commit_or_conflict(session: AsyncSession, *, detail: str) -> None:
    """``commit()``, aber eine Unique-Verletzung wird zur sauberen 409.

    Die Vorprüfungen in ``create_folder`` / ``patch_entry`` fangen den
    Normalfall früh und mit einer sprechenden Meldung ab; zwischen ihrer
    Auswahl und dem Commit liegen aber Await-Punkte, an denen eine zweite,
    für sich genommen völlig legitime Anfrage denselben Namen belegen kann.
    Schiedsrichter ist dann der partielle Unique-Index aus Migration 0043 —
    hier wird sein Einwand nur noch in dieselbe Antwort übersetzt."""

    try:
        await session.commit()
    except IntegrityError:
        await session.rollback()
        raise HTTPException(409, detail=detail) from None


# --- Zustandswechsel: bedingtes UPDATE entscheidet --------------------


async def _claim(
    session: AsyncSession,
    *,
    guild_id: int,
    entry_id: int,
    to_trash: bool,
    actor_id: int | None,
    now: datetime,
) -> bool:
    """Den Zustandswechsel beanspruchen. ``True``, wenn diese Anfrage ihn
    gewonnen hat.

    Der Zustand von vorher steht in der WHERE-Klausel, nicht in einer vorher
    gelesenen Kopie — deshalb kann ein zweiter Aufruf denselben Wechsel nicht
    ein zweites Mal vollziehen und das Kontingent nicht ein zweites Mal
    verschieben."""

    values: dict[str, object] = {"updated_at": now}
    if to_trash:
        values["deleted_at"] = now
        values["deleted_by_id"] = actor_id
        precondition = DropboxFile.deleted_at.is_(None)
    else:
        values["deleted_at"] = None
        values["deleted_by_id"] = None
        precondition = DropboxFile.deleted_at.is_not(None)

    result = await session.execute(
        update(DropboxFile)
        .where(
            DropboxFile.guild_id == guild_id,
            DropboxFile.id == entry_id,
            precondition,
        )
        .values(**values)
        .execution_options(synchronize_session=False)
    )
    return result.rowcount == 1


async def _subtree(
    session: AsyncSession,
    *,
    guild_id: int,
    folder: DropboxFile,
    marker: datetime | None,
    verb: str,
) -> list[DropboxFile]:
    """Die Nachkommen, die diese Kaskade betrifft.

    ``marker is None`` → alle **lebenden** Nachkommen (Weg in den
    Papierkorb). Sonst die Nachkommen, die **mit diesem Ordner zusammen**
    hineingingen, erkannt am identischen ``deleted_at``: die Kaskade stempelt
    Ordner und Teilbaum mit genau demselben Zeitpunkt. Das erspart eine eigene
    Spalte (und damit eine Migration) und trifft die richtige Menge — ein
    Kind, das schon vorher einzeln im Papierkorb lag, trägt einen anderen
    Stempel und bleibt dort, genau so, wie der Nutzer es abgelegt hat."""

    condition = (
        DropboxFile.deleted_at.is_(None)
        if marker is None
        else DropboxFile.deleted_at == marker
    )
    rows = list(
        (
            await session.execute(
                select(DropboxFile)
                .where(*subtree_filter(guild_id, folder))
                .where(condition)
                .limit(MAX_CASCADE_ROWS + 1)
            )
        ).scalars()
    )
    if len(rows) > MAX_CASCADE_ROWS:
        raise HTTPException(
            409,
            detail=(
                f"folder holds too many entries to {verb} in one go — "
                "work through it in smaller steps"
            ),
        )
    return rows


async def _set_deleted_state(
    session: AsyncSession,
    *,
    ids: list[int],
    deleted_at: datetime | None,
    deleted_by_id: int | None,
    now: datetime,
) -> None:
    if not ids:
        return
    await session.execute(
        update(DropboxFile)
        .where(DropboxFile.id.in_(ids))
        .values(
            deleted_at=deleted_at,
            deleted_by_id=deleted_by_id,
            updated_at=now,
        )
        .execution_options(synchronize_session=False)
    )


# --- Die beiden Wege, die die Routen benutzen -------------------------


async def perform_trash(
    session: AsyncSession,
    *,
    guild_id: int,
    entry: DropboxFile,
    actor_id: int,
) -> DropboxConfig | None:
    """Eintrag in den Papierkorb legen und das Kontingent entlasten.

    Bei einem Ordner geht der **ganze Teilbaum** mit. Ohne das blieben seine
    Kinder als lebende Zeilen unter einem Elternpfad zurück, den keine Ansicht
    mehr betreten kann — und nach dem endgültigen Purge des Ordners als
    unerreichbare, aber weiter kontingent-belastende Datenleichen.

    Gibt die (gesperrt gelesene) Konfigurationszeile zurück, damit die Route
    das Kontingent-Ereignis senden kann; ``None``, wenn die Community keine
    hat."""

    async with with_quota_lock(guild_id):
        cfg = await locked_config(session, guild_id)
        now = utc_now()
        children = (
            await _subtree(
                session, guild_id=guild_id, folder=entry, marker=None, verb="trash"
            )
            if entry.kind == DROPBOX_KIND_FOLDER
            else []
        )
        won = await _claim(
            session,
            guild_id=guild_id,
            entry_id=entry.id,
            to_trash=True,
            actor_id=actor_id,
            now=now,
        )
        if not won:
            # Eine parallele Anfrage war schneller und hat bereits abgebucht.
            # Dieselbe Antwort wie für einen Eintrag, den es nie gab.
            await session.rollback()
            raise HTTPException(404, detail="entry not found")
        await _set_deleted_state(
            session,
            ids=[c.id for c in children],
            deleted_at=now,
            deleted_by_id=actor_id,
            now=now,
        )
        freed = _own_bytes(entry) + sum(_own_bytes(c) for c in children)
        if cfg is not None and freed:
            bump_used(cfg, -freed)
        await session.commit()
    return cfg


async def perform_restore(
    session: AsyncSession, *, guild_id: int, entry: DropboxFile
) -> DropboxConfig | None:
    """Eintrag (samt mitgelöschtem Teilbaum) aus dem Papierkorb holen.

    Die Kontingentprüfung läuft über die **Summe** des Teilbaums — ein Ordner
    darf nicht halb zurückkommen, weil die Community nur für die ersten Dateien
    Platz hat."""

    marker = entry.deleted_at
    async with with_quota_lock(guild_id):
        cfg = await locked_config(session, guild_id)
        now = utc_now()
        children = (
            await _subtree(
                session, guild_id=guild_id, folder=entry, marker=marker,
                verb="restore",
            )
            if entry.kind == DROPBOX_KIND_FOLDER and marker is not None
            else []
        )
        needed = _own_bytes(entry) + sum(_own_bytes(c) for c in children)
        if cfg is not None and needed:
            projected = cfg.used_bytes + needed
            if projected > cfg.total_quota_bytes:
                raise HTTPException(
                    409,
                    detail=(
                        "restore would exceed the community's quota "
                        f"(free: {cfg.total_quota_bytes - cfg.used_bytes} bytes)"
                    ),
                )
        won = await _claim(
            session,
            guild_id=guild_id,
            entry_id=entry.id,
            to_trash=False,
            actor_id=None,
            now=now,
        )
        if not won:
            await session.rollback()
            raise HTTPException(404, detail="entry not in trash")
        await _set_deleted_state(
            session,
            ids=[c.id for c in children],
            deleted_at=None,
            deleted_by_id=None,
            now=now,
        )
        if cfg is not None and needed:
            bump_used(cfg, +needed)
        # Zurückholen kann in einen inzwischen belegten Namen laufen — dann
        # entscheidet der Unique-Index, nicht ein 500er.
        await commit_or_conflict(
            session, detail=f"'{entry.name}' already exists at this path"
        )
    return cfg
