"""Verschluesselte Anhaenge — Hochladen und Abrufen (Etappe E, E2E-DM).

Zwei Routen, beide DM-only wie das uebrige Postfach:

``POST /postfach/anhaenge/upload-url`` legt eine Anhang-Zeile OHNE
Dateinamen, OHNE Typ und OHNE Maße an und gibt eine vorsignierte
PUT-Adresse heraus. Die Bytes fliessen direkt zwischen Klient und MinIO,
der Gateway sieht sie nie — genau wie im Klartext-Weg.

``POST /postfach/anhaenge/{id}/abrufadresse`` gibt eine kurzlebige
signierte GET-Adresse heraus, aber nur an ein Geraet, das eine offene
Zustellung zu diesem Anhang hat (``postfach_anhaenge.py::darf_anhang_abrufen``).
Fail-closed: jeder andere bekommt 404, ohne Unterschied zwischen „gibt es
nicht" und „gehoert dir nicht".

**Seit Design §11.1 ist diese zweite Route der RUECKFALL, nicht der
Regelweg.** Beim Hochladen schiebt
``routes/postfach_anhaenge_laufwerk.py`` das Chiffrat in den Archiv-Ordner
jedes Beteiligten und gibt Pulses eigene Kopie frei; der Empfaenger holt die
Datei danach aus seinem eigenen Laufwerk. Fuer einen so verteilten Anhang
antwortet die Abrufadresse mit **410** (``anhang_im_laufwerk``) statt mit
einer formal gueltigen Adresse auf geloeschte Bytes — s. dort. Sie bleibt
zustaendig fuer Anhaenge von vor der Umstellung und fuer den Fall, dass die
Verteilung nicht lief (dann haelt Pulse den Klumpen unveraendert weiter).

**``cloud_dm_attachments_enabled`` gilt hier NICHT, und das ist eine
Entscheidung, kein Versehen.** Der Schalter steht fuer „Anhaenge im
UNVERSCHLUESSELTEN Weg" (``routes/attachments.py::_enforce_dm_attachment_policy``):
die Cloud bietet keinen privaten Upload-Kanal an, den sie zwar lesen
koennte, aber nicht pruefen darf. Ein verschluesselter Anhang stellt diese
Frage nicht — der Server kann ihn ohnehin nicht lesen, und er behaelt ihn
nicht (verteilt: gleich nach dem Hochladen freigegeben; sonst: faellt mit
seinem letzten Umschlag). Anhaenge sind laut Spec §3 ausdruecklich
der sichtbare Gegenwert fuer den verschluesselten Weg; haengte er am selben
Schalter, gaebe es sie nirgends.
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, status

import dcc_chat_gateway.config as chat_config
from dcc_chat_gateway import ratelimit, s3
from dcc_chat_gateway.db import SessionDep
from dcc_chat_gateway.models import MessageAttachment
from dcc_chat_gateway.postfach_anhaenge import darf_anhang_abrufen
from dcc_chat_gateway.routes.attachments import _storage_key
from dcc_chat_gateway.routes.postfach import _channel_zugriff_pruefen
from dcc_chat_gateway.schemas import (
    AttachmentDownloadOut,
    AttachmentUploadOut,
    PostfachAnhangAbrufIn,
    PostfachAnhangUploadIn,
)
from dcc_chat_gateway.schluessel_nachweis import pruefe_geraet
from dcc_chat_gateway.security import CurrentUser
from dcc_chat_gateway.snowflake import next_id

router = APIRouter(tags=["postfach"])

#: Was der Klient wirklich hochlaedt: undurchsichtige Bytes. Der Typ wird in
#: die vorsignierte Adresse eingebacken, MinIO weist einen Upload mit anderem
#: Typ ab — er ist damit eine Zusicherung an den Objektspeicher, KEINE
#: Angabe ueber den Inhalt (die kennt der Server nicht und legt er nicht ab).
_KLUMPEN_TYP = "application/octet-stream"


def _max_bytes() -> int:
    """Die Obergrenze eines verschluesselten Anhangs.

    **Seit §11.3 die Einstellung ``ablage_anhang_max_bytes``**, nicht mehr die
    Datenbankzeile ``ChatSettings.dm_attachment_max_size_bytes``. Der Grund
    ist nicht Aufraeumen: der Anhang wandert jetzt in die Cloud-Ordner aller
    Beteiligten, die Grenze schuetzt also fremden Speicherplatz und nicht mehr
    den eigenen. Sie muss deshalb dieselbe Zahl sein, die
    ``ablage_anhang_verteilung`` beim Weiterschieben durchsetzt und die
    ``GET /capabilities`` dem Klienten nennt — drei Stellen, eine Quelle.
    Der Zahlenwert aendert sich dabei praktisch nicht (Vorgabe war 25 MiB,
    ist jetzt 25 MB).

    Die Datenbankzeile bleibt unangetastet und gilt weiter fuer den
    KLARTEXT-Weg (``routes/attachments.py``) — dort ist sie die richtige
    Grenze, weil dort der eigene Objektspeicher bezahlt.
    """
    return chat_config.get_settings().ablage_anhang_max_bytes


@router.post(
    "/postfach/anhaenge/upload-url",
    response_model=AttachmentUploadOut,
    status_code=201,
)
async def anhang_upload_adresse(
    body: PostfachAnhangUploadIn,
    session: SessionDep,
    user: CurrentUser,
) -> AttachmentUploadOut:
    """Legt die Anhang-Zeile an und gibt die PUT-Adresse(n) heraus.

    Kein Geraete-Nachweis: was hier entsteht, ist eine leere Huelle, die
    ohne eine spaetere Einlieferung nach einer Stunde vom Reaper wegfaellt
    (``routes/attachments.py::_reap_once``). Die teure Verifikation gehoert
    an die Einlieferung, wo die Bindung an einen Umschlag entsteht — dort
    prueft ``postfach_anhaenge.py::binde_anhaenge``, dass der Anhang
    demselben Konto und demselben Kanal gehoert.
    """
    # Derselbe Zaehler wie der Klartext-Weg ("attach"): ein Konto soll nicht
    # doppelt so viele Upload-Adressen ziehen koennen, nur weil es zwei Wege
    # gibt.
    if not ratelimit.check("attach", user.id):
        raise HTTPException(
            status.HTTP_429_TOO_MANY_REQUESTS, detail="rate limit exceeded"
        )
    channel_id = int(body.channel_id)
    # Dieselbe Kanalregel wie beim Einliefern: DM, Mitglied, nicht geblockt,
    # befreundet. Ohne sie liesse sich Speicher in einem fremden Kanal
    # belegen.
    await _channel_zugriff_pruefen(session, channel_id, user)

    max_bytes = _max_bytes()
    if body.size > max_bytes:
        raise HTTPException(
            status.HTTP_413_CONTENT_TOO_LARGE,
            detail=f"file too large ({body.size} > {max_bytes} bytes)",
        )
    thumb_key: str | None = None
    anhang_id = next_id()
    if body.has_thumb:
        if body.thumb_size is None:
            raise HTTPException(400, detail="thumb_size required when has_thumb=true")
        if body.thumb_size > max_bytes:
            raise HTTPException(413, detail="thumbnail too large")
        thumb_key = _storage_key("thumb", channel_id, anhang_id)
    storage_key = _storage_key("att", channel_id, anhang_id)

    # Was hier NICHT gesetzt wird, ist der Kern der Etappe: ``filename``,
    # ``mime``, ``width``, ``height``, ``thumb_width``, ``thumb_height``
    # bleiben NULL. Alle sechs Spalten sind seit Migration 0007 nullable,
    # ausdruecklich fuer diesen Fall.
    session.add(
        MessageAttachment(
            id=anhang_id,
            message_id=None,
            channel_id=channel_id,
            uploader_id=user.id,
            storage_key=storage_key,
            size=body.size,
            thumb_storage_key=thumb_key,
        )
    )
    await session.commit()

    upload_url = await s3.presigned_put_url(
        storage_key, content_type=_KLUMPEN_TYP, content_length=body.size
    )
    thumb_upload_url: str | None = None
    if thumb_key is not None:
        thumb_upload_url = await s3.presigned_put_url(
            thumb_key, content_type=_KLUMPEN_TYP, content_length=body.thumb_size
        )
    return AttachmentUploadOut(
        id=anhang_id, upload_url=upload_url, thumb_upload_url=thumb_upload_url
    )


@router.post(
    "/postfach/anhaenge/{anhang_id}/abrufadresse",
    response_model=AttachmentDownloadOut,
)
async def anhang_abrufadresse(
    anhang_id: int,
    body: PostfachAnhangAbrufIn,
    session: SessionDep,
    user: CurrentUser,
) -> AttachmentDownloadOut:
    """Signierte GET-Adresse fuer ein Geraet, das eine Zustellung dazu hat.

    Das Geraet steht im Rumpf und muss zum angemeldeten Konto gehoeren
    (``schluessel_nachweis.py``); ob es zu DIESEM Anhang eine offene
    Zustellung hat, entscheidet ``darf_anhang_abrufen`` eine Zeile weiter
    unten — das ist die Bedingung, an der die Route wirklich haengt.
    """
    geraet = await pruefe_geraet(session, user, body.device_pubkey)

    zeile = await session.get(MessageAttachment, anhang_id)
    # Eine Zeile ohne ``postfach_gebunden_am`` ist entweder ein
    # Klartext-Anhang oder eine noch nicht eingelieferte Huelle. Beide
    # gehoeren nicht hierher: der Klartext-Weg fuehrt seine eigene
    # Rechtepruefung ueber Kanal und Nachricht
    # (``routes/attachments.py::refresh_download_url``), und wer diesen Weg
    # ueber die verschluesselte Route bediente, umginge sie.
    if (
        zeile is None
        or zeile.deleted_at is not None
        or zeile.postfach_gebunden_am is None
    ):
        raise HTTPException(status_code=404, detail="anhang_nicht_gefunden")
    if not await darf_anhang_abrufen(
        session,
        anhang_id=anhang_id,
        device_pubkey=geraet,
        user_id=user.id,
    ):
        # Dieselbe 404 wie „gibt es nicht" — wer keine Zustellung hat, soll
        # nicht einmal erfahren, ob die Kennung existiert.
        raise HTTPException(status_code=404, detail="anhang_nicht_gefunden")

    # **410 statt einer Adresse ins Leere** (Design §11.1). Ist der Anhang in
    # die Laufwerke der Beteiligten gewandert, hat Pulse keine Bytes mehr —
    # eine vorsignierte Adresse waere hier syntaktisch einwandfrei und
    # inhaltlich tot, und der Klient saehe einen 404 des Objektspeichers, der
    # von „Anhang verfallen" nicht zu unterscheiden ist. Die eigene Kennung
    # sagt ihm stattdessen genau, wo die Datei jetzt liegt: in seinem eigenen
    # Archiv-Ordner.
    #
    # **NACH der Rechtepruefung, nicht davor.** Sonst waere der Unterschied
    # 410/404 ein Orakel: wer eine fremde Kennung raet, erfuehre an der 410,
    # dass es sie gibt. Der Preis ist keiner — ein Berechtigter kommt ohnehin
    # bis hierher.
    if zeile.laufwerk_verteilt_am is not None:
        raise HTTPException(status_code=410, detail="anhang_im_laufwerk")

    # Ohne ``filename``/``mime`` kann und soll hier nichts gesetzt werden:
    # ``inline=False`` und kein Dateiname heisst, der Browser bekommt reine
    # Bytes ohne Namen — der richtige Name steht nur im entschluesselten
    # Umschlag beim Empfaenger.
    url = await s3.presigned_get_url(zeile.storage_key, inline=False)
    thumb_url: str | None = None
    if zeile.thumb_storage_key is not None:
        thumb_url = await s3.presigned_get_url(zeile.thumb_storage_key, inline=False)
    return AttachmentDownloadOut(url=url, thumb_url=thumb_url)
