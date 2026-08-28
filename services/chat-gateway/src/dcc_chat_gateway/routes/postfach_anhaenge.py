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

**``cloud_dm_attachments_enabled`` gilt hier NICHT, und das ist eine
Entscheidung, kein Versehen.** Der Schalter steht fuer „Anhaenge im
UNVERSCHLUESSELTEN Weg" (``routes/attachments.py::_enforce_dm_attachment_policy``):
die Cloud bietet keinen privaten Upload-Kanal an, den sie zwar lesen
koennte, aber nicht pruefen darf. Ein verschluesselter Anhang stellt diese
Frage nicht — der Server kann ihn ohnehin nicht lesen, und der Klumpen
faellt mit seinem letzten Umschlag. Anhaenge sind laut Spec §3 ausdruecklich
der sichtbare Gegenwert fuer den verschluesselten Weg; haengte er am selben
Schalter, gaebe es sie nirgends.
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request, status

from dcc_chat_gateway import ratelimit, s3
from dcc_chat_gateway.db import SessionDep
from dcc_chat_gateway.models import ChatSettings, MessageAttachment
from dcc_chat_gateway.postfach_anhaenge import darf_anhang_abrufen
from dcc_chat_gateway.routes.attachments import _storage_key
from dcc_chat_gateway.routes.postfach import _channel_zugriff_pruefen, _require_redis
from dcc_chat_gateway.schemas import (
    AttachmentDownloadOut,
    AttachmentUploadOut,
    PostfachAnhangAbrufIn,
    PostfachAnhangUploadIn,
)
from dcc_chat_gateway.schluessel_nachweis import baue_nutzlast, pruefe_geraet
from dcc_chat_gateway.security import CurrentUser
from dcc_chat_gateway.snowflake import next_id

router = APIRouter(tags=["postfach"])

#: Was der Klient wirklich hochlaedt: undurchsichtige Bytes. Der Typ wird in
#: die vorsignierte Adresse eingebacken, MinIO weist einen Upload mit anderem
#: Typ ab — er ist damit eine Zusicherung an den Objektspeicher, KEINE
#: Angabe ueber den Inhalt (die kennt der Server nicht und legt er nicht ab).
_KLUMPEN_TYP = "application/octet-stream"

#: Ohne Einstellungszeile (Migration 0006 seedet sie): dieselben Werte wie
#: ``routes/attachments.py::_limits_for_channel``.
_NOTFALL_MAX_BYTES = 26214400


async def _max_bytes(session) -> int:
    einstellungen = await session.get(ChatSettings, 1)
    if einstellungen is None:
        return _NOTFALL_MAX_BYTES
    return einstellungen.dm_attachment_max_size_bytes


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
    await _channel_zugriff_pruefen(session, channel_id, user.id)

    max_bytes = await _max_bytes(session)
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
    request: Request,
    session: SessionDep,
    user: CurrentUser,
) -> AttachmentDownloadOut:
    """Signierte GET-Adresse fuer ein Geraet, das eine Zustellung dazu hat.

    Der Geraete-Nachweis laeuft ueber ``schluessel_nachweis.py`` mit dem
    eigenen Zweck ``"postfach-anhang"``, und die Unterschrift bindet die
    Anhang-Kennung ein — eine fuer einen anderen Anhang (oder fuer das
    Abholen) geleistete Unterschrift gilt hier nicht.
    """
    redis = _require_redis(request)
    claims = await pruefe_geraet(
        body.cert,
        baue_nutzlast("postfach-anhang", str(anhang_id)),
        body.signatur,
        user,
        redis,
    )

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
        device_pubkey=claims.device_pubkey,
        user_id=user.id,
    ):
        # Dieselbe 404 wie „gibt es nicht" — wer keine Zustellung hat, soll
        # nicht einmal erfahren, ob die Kennung existiert.
        raise HTTPException(status_code=404, detail="anhang_nicht_gefunden")

    # Ohne ``filename``/``mime`` kann und soll hier nichts gesetzt werden:
    # ``inline=False`` und kein Dateiname heisst, der Browser bekommt reine
    # Bytes ohne Namen — der richtige Name steht nur im entschluesselten
    # Umschlag beim Empfaenger.
    url = await s3.presigned_get_url(zeile.storage_key, inline=False)
    thumb_url: str | None = None
    if zeile.thumb_storage_key is not None:
        thumb_url = await s3.presigned_get_url(zeile.thumb_storage_key, inline=False)
    return AttachmentDownloadOut(url=url, thumb_url=thumb_url)
