"""Verschluesselte Anhaenge — Bindung und Berechtigung (Etappe E, E2E-DM).

Der Datenweg des Anhangs bleibt derselbe wie im Klartext-Weg: der Klient laedt
die Bytes ueber eine vorsignierte PUT-Adresse direkt zu MinIO, der Gateway
sieht sie nie. Neu ist nur, WORAN der Anhang haengt.

Im Klartext-Weg haengt er an einer ``messages``-Zeile. Die gibt es hier
nicht — eine verschluesselte Nachricht erzeugt keine (Spec §4). Er haengt
deshalb an den Umschlaegen, die seinen Dateischluessel tragen
(``DmAnhangBezug``), und faellt mit deren letztem weg
(``postfach_pflege.py::sweep_verwaiste_anhaenge``).

Zwei Dinge liegen hier statt in ``routes/``: die Bindung braucht
``routes/postfach.py`` (das die Routen-Datei sonst importieren muesste, die
ihrerseits aus ``routes/postfach.py`` importiert — ein Kreis), und die
Berechtigungsfrage ist eine reine Datenbank-Aussage ohne HTTP.

**Der Server speichert zu einem verschluesselten Anhang keinen Dateinamen,
keinen Typ und keine Maße.** Das erzwingt die Anlegestelle
(``routes/postfach_anhaenge.py``), nicht dieses Modul; hier wird nur nie
etwas davon gesetzt.
"""

from __future__ import annotations

from collections.abc import Sequence
from datetime import UTC, datetime

from fastapi import HTTPException
from sqlalchemy import exists, select
from sqlalchemy.ext.asyncio import AsyncSession

from dcc_chat_gateway.models import DmAnhangBezug, DmZustellung, MessageAttachment


async def binde_anhaenge(
    session: AsyncSession,
    *,
    anhang_ids: Sequence[int],
    channel_id: int,
    uploader_id: int,
) -> list[MessageAttachment]:
    """Prueft die genannten Anhaenge und markiert sie als eingeliefert.

    Dieselben vier Bedingungen wie ``routes/attachments.py::bind_attachments``
    im Klartext-Weg, plus eine fuenfte: der Anhang darf **nie** an einer
    Nachricht haengen. Ein Klartext-Anhang, der ueber diesen Weg an einen
    Umschlag gebunden wuerde, waere spaeter ueber die Postfach-Abrufadresse
    zu holen — vorbei an der Kanal- und Rechtepruefung, die der
    Klartext-Weg dafuer fuehrt.

    Wirft 400, sobald eine Kennung nicht passt; die ganze Anfrage faellt
    dann, wie im Klartext-Weg. Der Aufrufer committet.
    """
    ids = list(dict.fromkeys(anhang_ids))
    if not ids:
        return []
    zeilen = (
        await session.execute(
            select(MessageAttachment).where(MessageAttachment.id.in_(ids))
        )
    ).scalars().all()
    nach_id = {zeile.id: zeile for zeile in zeilen}
    jetzt = datetime.now(UTC)
    gebunden: list[MessageAttachment] = []
    for anhang_id in ids:
        zeile = nach_id.get(anhang_id)
        # Eine einzige Fehlermeldung fuer jeden Fehlschlag: welcher der
        # Gruende zutrifft, verraet einem Fremden sonst, ob es die Kennung
        # ueberhaupt gibt und in welchem Kanal sie liegt.
        if (
            zeile is None
            or zeile.deleted_at is not None
            or zeile.message_id is not None
            or zeile.uploader_id != uploader_id
            or zeile.channel_id != channel_id
        ):
            raise HTTPException(status_code=400, detail="anhang_nicht_verwendbar")
        zeile.postfach_gebunden_am = jetzt
        gebunden.append(zeile)
    return gebunden


async def bezuege_anlegen(
    session: AsyncSession, *, nutzlast_id: int, anhang_ids: Sequence[int]
) -> None:
    """Haengt jeden Anhang an DIESE Nutzlast. Kein Commit.

    Je Empfaengergeraet entsteht bei einer DM eine eigene Nutzlast, der
    Aufrufer ruft das also einmal je angelegtem Umschlag — deshalb nimmt die
    Funktion eine Nutzlast und viele Anhaenge, nicht umgekehrt.

    **Das ``flush`` ist Pflicht, nicht Vorsicht** (nachgemessen: ohne es
    scheitert jede Einlieferung mit Anhang an „FOREIGN KEY constraint
    failed"). SQLAlchemy leitet die Reihenfolge der INSERTs zwischen zwei
    Tabellen NICHT aus dem Fremdschluessel her, solange kein
    ``relationship()`` sie verbindet — ``dm_anhang_bezuege`` ginge sonst vor
    ``dm_nutzlasten``. Dass ``dm_zustellungen`` dieselbe Konstruktion ohne
    ``flush`` ueberlebt, ist reines Glueck der alphabetischen Reihenfolge.
    """
    if not anhang_ids:
        return
    await session.flush()
    for anhang_id in anhang_ids:
        session.add(DmAnhangBezug(nutzlast_id=nutzlast_id, anhang_id=anhang_id))


async def darf_anhang_abrufen(
    session: AsyncSession, *, anhang_id: int, device_pubkey: str, user_id: int
) -> bool:
    """Hat DIESES Geraet einen Umschlag, der diesen Anhang oeffnen kann?

    Fail-closed: nur eine noch offene Zustellung an genau dieses Geraet UND
    dieses Konto (zwei unabhaengige Bedingungen, wie beim Abholen und
    Quittieren) auf eine Nutzlast, die den Anhang traegt, gibt das Recht.
    Wer nur im selben Kanal sitzt, bekommt nichts — der Dateischluessel
    steckt im Umschlag, und wer keinen hat, koennte mit den Bytes ohnehin
    nichts anfangen.

    Dass das Recht mit der Zustellung endet, ist Absicht und hat eine Folge
    fuer den Klienten: **er muss den Anhang holen, BEVOR er quittiert.**
    Nach der Quittung faellt die Nutzlast, und mit ihr der Anhang selbst.
    """
    # Ueber die Zustellung, nicht ueber die Nutzlast: eine Zustellung kann
    # ohne ihre Nutzlast nicht existieren (Fremdschluessel mit Kaskade), der
    # Umweg ueber ``DmNutzlast`` waere eine dritte Tabelle ohne Aussage.
    return (
        await session.execute(
            select(
                exists().where(
                    DmAnhangBezug.anhang_id == anhang_id,
                    DmZustellung.nutzlast_id == DmAnhangBezug.nutzlast_id,
                    DmZustellung.empfaenger_device_pubkey == device_pubkey,
                    DmZustellung.empfaenger_user_id == user_id,
                )
            )
        )
    ).scalar_one()


__all__ = ["binde_anhaenge", "bezuege_anlegen", "darf_anhang_abrufen"]
