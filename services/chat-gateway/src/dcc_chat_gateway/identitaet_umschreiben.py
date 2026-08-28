"""Bestandszeilen von der synthetischen ID auf die Cloud-Kennung heben.

Warum es das gibt
-----------------
Bis zum Ticket-Weg trug ein Self-Host je Nutzer eine synthetische ID
(``SHA256(pairwise_sub)[:8]``, siehe ``synthesize_self_host_user_id``). Der
Server kann sie nicht zurückrechnen — die Cloud aber vorwärts und liefert sie als
``legacy_uid`` im Ticket mit. Beim ersten Anmelden auf dem neuen Weg wandern die
Zeilen dieses einen Nutzers.

Die Regel, was umgeschrieben wird
---------------------------------
**Umgeschrieben wird, was sich eindeutig als Nutzerkennung erkennen lässt.
Stehen gelassen wird, was sich nicht erkennen lässt.**

Das ist nicht dasselbe wie „Verlaufsdaten anfassen oder nicht". Ein Audit-Eintrag
wird durch die Umschreibung nicht verfälscht: Es handelt sich um denselben
Menschen, nur um eine andere Schreibweise seiner Kennung. Verfälscht wäre er,
wenn er danach auf eine ANDERE Person zeigte — und genau das droht dort, wo die
Spalte gar nicht verrät, ob eine Kennung darin ein Nutzer, eine Rolle oder eine
Nachricht ist.

Deshalb wandern ``admin_audit_log.actor_id`` und ``mod_audit_log.actor_user_id``
mit (beide immer Nutzer), ``mod_audit_log.target_id`` nur bei
``target_kind='user'`` — und ``admin_audit_log.target_id`` gar nicht: Diese
Tabelle hat keine Typspalte, der Typ steckt implizit in ``action``. Ebenso
unangetastet bleibt das freie ``payload``-JSON beider Tabellen; ein ``UPDATE``
sieht dort nicht hinein.

Preis, bewusst und hiermit dokumentiert: ``admin_audit_log.target_id`` und die
Kennungen in den ``payload``-Feldern verweisen nach der Umschreibung auf eine
Kennung, die nirgends mehr auflöst. Das ist Verhalten, keine Panne.

Die bedingten Spalten sind die eigentliche Gefahr
-------------------------------------------------
``target_id``, ``subject_id`` und Geschwister heissen nicht nach einem Nutzer und
sind es nur manchmal. Eine Liste, die über Spaltennamen entsteht, findet sie
nicht — dieselbe Fehlerklasse, die im Projekt schon bei Bau-Rezepten und
Lizenztexten zugeschlagen hat: Was in keinem Namensmuster steht, fällt aus der
Liste und in keinem Test auf.
"""

from __future__ import annotations

from typing import Any

from sqlalchemy import text

from dcc_chat_gateway.models.devices import SUBJECT_USER

#: (Tabelle, Spalte) — trägt IMMER eine Nutzer-ID.
SPALTEN: list[tuple[str, str]] = [
    ("admin_audit_log", "actor_id"),
    ("devices", "owner_user_id"),
    ("device_grants", "created_by_user_id"),
    ("user_privacy", "user_id"),
    ("guilds", "owner_id"),
    ("guild_members", "user_id"),
    ("guild_bans", "user_id"),
    ("community_invite_notifications", "inviter_user_id"),
    ("community_invite_notifications", "invitee_user_id"),
    ("messages", "author_id"),
    ("message_reactions", "user_id"),
    ("cached_user_profiles", "synthetic_user_id"),
    ("reports", "reporter_user_id"),
    ("reports", "target_user_id"),
    ("reports", "resolver_user_id"),
    ("mod_audit_log", "actor_user_id"),
    ("web_push_subscriptions", "user_id"),
    ("instance_plugin_allowlist", "added_by_user_id"),
    ("guild_plugins", "enabled_by_user_id"),
    ("guild_plugin_state", "updated_by_user_id"),
    ("member_roles", "user_id"),
    ("user_preferences", "user_id"),
    ("channel_voice_pulls", "user_id"),
]

#: (Tabelle, Spalte, Bedingungsspalte, Wert) — Nutzer-ID nur bei diesem Wert.
#: Die Werte kommen, wo es sie gibt, aus der Quelle (``SUBJECT_USER``) statt als
#: Abschrift — eine Abschrift veraltet still, wenn jemand die Konstante ändert.
BEDINGTE_SPALTEN: list[tuple[str, str, str, Any]] = [
    ("permission_overwrites", "target_id", "target_type", 1),  # 0 = Rolle
    ("message_mentions", "target_id", "mention_type", 0),  # 1 = Rolle, 2 = alle
    ("device_grants", "subject_id", "subject_type", SUBJECT_USER),
    # ``mod_audit_log.target_kind`` kennt keine Konstante; die Schreiber setzen
    # den Wert als Zeichenkette (``routes/bans.py``, ``routes/guilds.py``).
    ("mod_audit_log", "target_id", "target_kind", "user"),
]

#: (Tabelle, Spalte) — lautet heute auf das Pseudonym, künftig auf die Kennung.
TEXT_SPALTEN: list[tuple[str, str]] = [
    ("instance_members", "user_identifier"),
    ("cached_user_profiles", "user_identifier"),
]

#: Wo eine Kollision überhaupt schaden könnte: Tabellen, in denen die Kennung
#: eine Identität BENENNT statt sie nur zu erwähnen. Eine Erwähnung (etwa in
#: einem Audit-Eintrag) darf dieselbe Zahl mehrfach tragen; eine Mitgliedschaft
#: nicht.
_KOLLISIONSPRUEFUNG: list[tuple[str, str]] = [
    ("guild_members", "user_id"),
    ("cached_user_profiles", "synthetic_user_id"),
]


async def umschreiben(
    session: Any, *, alt_uid: int, neu_uid: int, alt_text: str, neu_text: str
) -> int:
    """Hebt die Zeilen eines Nutzers auf die neue Kennung.

    Gibt die Zahl der geänderten Zeilen zurück. Wirft ``ValueError``, wenn die
    Ziel-Kennung auf diesem Server bereits eine andere Identität benennt.

    Der Aufrufer sorgt für die Transaktion und dafür, dass das je Nutzer nur
    einmal läuft.
    """
    for tabelle, spalte in _KOLLISIONSPRUEFUNG:
        vorhanden = (
            await session.execute(
                text(f"SELECT count(*) FROM {tabelle} WHERE {spalte} = :neu").bindparams(
                    neu=neu_uid
                )
            )
        ).scalar_one()
        if vorhanden:
            raise ValueError(
                f"Kollision: {tabelle}.{spalte} traegt {neu_uid} bereits "
                "— nicht umgeschrieben"
            )

    geaendert = 0
    for tabelle, spalte in SPALTEN:
        r = await session.execute(
            text(f"UPDATE {tabelle} SET {spalte} = :neu WHERE {spalte} = :alt").bindparams(
                neu=neu_uid, alt=alt_uid
            )
        )
        geaendert += r.rowcount or 0

    for tabelle, spalte, bed_spalte, bed_wert in BEDINGTE_SPALTEN:
        r = await session.execute(
            text(
                f"UPDATE {tabelle} SET {spalte} = :neu "
                f"WHERE {spalte} = :alt AND {bed_spalte} = :bed"
            ).bindparams(neu=neu_uid, alt=alt_uid, bed=bed_wert)
        )
        geaendert += r.rowcount or 0

    for tabelle, spalte in TEXT_SPALTEN:
        r = await session.execute(
            text(f"UPDATE {tabelle} SET {spalte} = :neu WHERE {spalte} = :alt").bindparams(
                neu=neu_text, alt=alt_text
            )
        )
        geaendert += r.rowcount or 0

    return geaendert
