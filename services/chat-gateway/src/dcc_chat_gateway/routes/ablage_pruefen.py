"""``POST /ablage/pruefen`` — die Verbindungsprobe eines Laufwerks.

**Warum diese Route ueberhaupt existiert.** Bis zum 2026-09-01 hat der
Verbinden-Dialog selbst geprobt: ein WebDAV-``PUT`` direkt aus dem Browser.
Das kann bei keinem Anbieter funktionieren, der nicht ausdruecklich CORS
freigibt — an einer echten Nextcloud gemessen, dort kommt auf Vorabfrage und
echtes ``PUT`` keine ``Access-Control-Allow-Origin``-Kopfzeile zurueck. Die
Begruendung im Detail steht in ``ablage_probe.py``.

**Sie ist bewusst NICHT kanalgebunden.** Dasselbe Laufwerk-Verbinden gibt es
an drei Stellen (Ablage-Kanal, Community-Dateiablage, persoenliches Archiv),
und geprueft wird immer dieselbe Adresse auf dieselbe Weise — vor dem
Anlegen des Ziels, teils bevor es das Ziel ueberhaupt gibt. Eine
kanalgebundene Route haette entweder eine Reihenfolge erzwungen, die es
nicht gibt, oder waere dreimal fast gleich dagewesen.

**Was diese Route NICHT tut: die Adresse speichern.** Das bleibt Sache von
``PUT .../ablage/laufwerk`` bzw. der Guild-Entsprechung. Wer hier prueft,
hat noch nichts hinterlegt — und wer hinterlegt, muss nicht geprueft haben.
Die Trennung ist Absicht: eine Probe, die nebenbei speichert, waere aus der
Sicht des Aufrufers ein Schreibzugriff im Gewand einer Abfrage.
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel, ConfigDict, Field

from dcc_chat_gateway import ratelimit
from dcc_chat_gateway.ablage_probe import ProbeErgebnis, probiere_ziel
from dcc_chat_gateway.ablage_ssrf import AblageAbrufFehler
from dcc_chat_gateway.security import CurrentUser

router = APIRouter()


class ProbeIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    freigabe_adresse: Annotated[str, Field(min_length=1, max_length=8192)]


class ProbeAus(BaseModel):
    """Spiegelt ``ProbeErgebnis`` aus ``web/src/lib/ablage/probe.ts``.

    ``schritt`` traegt dieselben vier Werte wie dort, weil die Oberflaeche
    ihren Text darueber nachschlaegt (``probeSchrittText.ts``).
    """

    gut: bool
    schritt: str | None = None
    grund: str | None = None


@router.post("/ablage/pruefen", response_model=ProbeAus)
async def ablage_pruefen(payload: ProbeIn, current: CurrentUser) -> ProbeAus:
    """Schreibt, liest, vergleicht und loescht eine Probedatei am Ziel.

    **Ein misslungener Versuch ist KEIN Fehlerstatus.** Die Route antwortet
    mit 200 und ``gut: false``: „dein Link kann nicht schreiben" ist ein
    Ergebnis der Pruefung, kein Fehler der Anfrage. Nur eine Adresse, die gar
    keine ist, wird mit 400 abgewiesen.

    **Die Ratenbegrenzung ist hier kein Beiwerk.** Die Route nimmt eine frei
    waehlbare Zieladresse entgegen und spricht sie an — genau die Bauform,
    aus der sonst ein Portscanner wird. Der SSRF-Schutz verhindert private
    Ziele, der Zaehler begrenzt zusaetzlich die Anzahl. Beides zusammen,
    nicht eins davon.
    """
    if not ratelimit.check("ablage_pruefen", current.id):
        raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, detail="rate limited")

    try:
        ergebnis: ProbeErgebnis = await probiere_ziel(freigabe_adresse=payload.freigabe_adresse)
    except AblageAbrufFehler as fehler:
        # Nur die Kennung, nie die Adresse — sie ist ein Schluessel in
        # Textform (s. ``ablage_probe.py``).
        raise HTTPException(status.HTTP_400_BAD_REQUEST, detail=str(fehler)) from fehler

    return ProbeAus(gut=ergebnis.gut, schritt=ergebnis.schritt, grund=ergebnis.grund)
