"""Wer in einer privaten Gruppe zustellen und Schluessel holen darf (Etappe G2).

Zwei Fragen, die ausserhalb von ``routes/private_gruppen.py`` gebraucht
werden und deshalb nicht dort stehen:

1. **Wem gehoert dieser Kanal?** — ``gruppen_teilnehmer``. Das Postfach
   braucht die Menge der Konten, in deren Geraete-Postfaecher ueberhaupt
   zugestellt werden darf (``routes/postfach.py``, Schritt 3 und die
   ``teilnehmer``-Skopierung darunter).
2. **Sind diese zwei zusammen in einer Gruppe?** — ``teilen_private_gruppe``.
   Ohne diese Auskunft koennte ein Mitglied die Geraeteschluessel eines
   anderen Mitglieds nicht abholen, mit dem es nicht befreundet ist
   (``schluessel_zugriff.py``) — und ohne Schluessel keine Olm-Sitzung, ohne
   Olm-Sitzung kein Verteilschluessel, ohne Verteilschluessel keine Gruppe.

**Bewusst NICHT ueber ``resolve_channel_for_user``.** Der Umsetzungsplan
(``docs/superpowers/plans/2026-08-28-etappe-g1-private-gruppen-kanal.md``,
Selbstpruefung) hat nachgezaehlt, dass fuenfzehn Dateien zwischen „DM" und
„Community" unterscheiden und eine dritte Kanalart dort ein Durchgang durch
den halben Dienst waere — meist landete eine Gruppe im ``else``-Zweig und
damit in einer Rechteauswertung, die keine Rolle findet. Dieses Modul
beantwortet stattdessen genau die zwei Fragen, die der verschluesselte Weg
stellt, an genau den zwei Stellen, die sie stellen. Die uebrigen dreizehn
Stellen sehen weiterhin keine Gruppe und weisen eine Gruppen-ID ab —
fail-closed, und genau so gewollt, solange der Klartext-Weg fuer Gruppen
nicht gebaut ist.

**Der Schalter greift hier mit.** Ist ``private_groups_enabled`` aus, tun
beide Funktionen so, als gaebe es die Gruppe nicht. Sonst bliebe ein Bestand,
der bei eingeschaltetem Schalter entstanden ist, nach dem Abschalten ueber
das Postfach weiter benutzbar — der Schalter wuerde dann nur die Verwaltung
sperren, nicht die Nutzung.
"""

from __future__ import annotations

from sqlalchemy import exists, select

from dcc_chat_gateway.models import PrivateGroupChannel, PrivateGroupMember


def _gruppen_freigeschaltet() -> bool:
    # Later-Import wie in ``routes/private_gruppen.py::
    # require_private_groups_enabled``: Test-Fixturen ersetzen
    # ``get_settings`` erst zur Aufrufzeit, nicht zur Importzeit.
    import dcc_chat_gateway.config as _cfg  # noqa: PLC0415

    return _cfg.get_settings().private_groups_enabled


async def gruppen_teilnehmer(session, kanal_id: int, user_id: int) -> set[int] | None:
    """Die Konto-IDs aller Mitglieder — oder ``None``.

    ``None`` heisst „fuer diesen Aufrufer ist das keine erreichbare private
    Gruppe": der Schalter ist aus, die ID gehoert zu keiner Gruppe, oder
    ``user_id`` ist kein Mitglied. Die drei Faelle werden bewusst NICHT
    unterschieden — der Aufrufer beantwortet sie ohnehin alle gleich (403),
    und eine Unterscheidung verriete einem Fremden, dass es die Gruppe gibt.
    """
    if not _gruppen_freigeschaltet():
        return None
    gruppe = await session.get(PrivateGroupChannel, kanal_id)
    if gruppe is None:
        return None
    mitglieder = set(
        (
            await session.execute(
                select(PrivateGroupMember.user_id).where(
                    PrivateGroupMember.gruppe_id == kanal_id
                )
            )
        )
        .scalars()
        .all()
    )
    # Mitgliedschaft und Teilnehmermenge in EINEM Schritt: wer nicht drin
    # steht, bekommt die Menge nicht zu sehen.
    if user_id not in mitglieder:
        return None
    return mitglieder


async def teilen_private_gruppe(session, a_id: int, b_id: int) -> bool:
    """Ob die beiden Konten mindestens eine private Gruppe gemeinsam haben.

    Ein Self-Join ueber ``private_group_members``: dieselbe ``gruppe_id``,
    zwei verschiedene ``user_id``. Ohne Kanalbezug, weil ``POST /keys/claim``
    keinen kennt — es fragt nach Konten, nicht nach einem Gespraech.
    """
    if a_id == b_id or not _gruppen_freigeschaltet():
        return False
    anderer = PrivateGroupMember.__table__.alias("anderer")
    return bool(
        (
            await session.execute(
                select(
                    exists()
                    .where(PrivateGroupMember.user_id == a_id)
                    .where(anderer.c.user_id == b_id)
                    .where(anderer.c.gruppe_id == PrivateGroupMember.gruppe_id)
                )
            )
        ).scalar_one()
    )
