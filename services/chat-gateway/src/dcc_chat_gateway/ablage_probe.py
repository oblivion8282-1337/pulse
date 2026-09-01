"""Die Verbindungsprobe eines Ablage-Laufwerks — serverseitig.

**Warum sie nicht im Browser bleiben konnte.** Der Verbinden-Dialog hat die
Probe bis zum 2026-09-01 selbst gefahren: ein roher WebDAV-Zugang, direkt
aus dem Browser beschrieben. Das kann nicht funktionieren, und zwar bei
keinem Anbieter, der nicht ausdruecklich CORS freigibt. An einer echten
Nextcloud gemessen (2026-09-01): auf die Vorabfrage **und** auf das echte
``PUT`` kommt keine einzige ``Access-Control-Allow-Origin``-Kopfzeile
zurueck, obwohl derselbe Aufruf per ``curl`` mit 201 durchgeht. Der Browser
bricht deshalb vor dem ersten Byte ab, und der Nutzer las
„Der Link durfte nicht schreiben" — eine Meldung, die ihn an die falsche
Stelle schickte, naemlich in die Freigabe-Einstellungen seiner Nextcloud,
wo alles richtig gesetzt war.

Der Entwurf sah den Weg ohnehin so vor: **Lesen darf direkt, Schreiben
laeuft ueber Pulse** (Entwurf §1, §4.0a; ``web/src/lib/ablage/
direktMitRueckfall.ts`` sagt es woertlich). Die Probe schreibt — sie gehoert
damit hierher, nicht in den Klienten. Der Klient prueft danach gar nichts
mehr selbst, er zeigt nur noch das Ergebnis.

**Was diese Datei mit dem Klienten teilen MUSS.** Die vier Schritte und
ihre Namen (``schreiben``/``lesen``/``vergleichen``/``loeschen``) sind der
Vertrag mit ``web/src/lib/ablage/probe.ts`` und
``probeSchrittText.ts`` — die Oberflaeche schlaegt den Text zum Schritt
dort nach. Wer hier einen Schritt umbenennt oder hinzufuegt, zieht beide
Stellen mit (CLAUDE.md: „eine Behauptung wird nie an nur EINER Stelle
korrigiert").

**Die Adresse ist ein Schluessel in Textform.** Sie wird nie geloggt, nie
in einer Antwort gespiegelt und nie an eine andere Gegenstelle geschickt
als die, die in ihr steht. Fehlermeldungen tragen darum Kennungen
(``upstream_fehler``), keine Adressen.

**SSRF gilt hier schaerfer als beim Abruf.** ``ablage_ssrf.hole()`` haelt
ausdruecklich fest, dass seine Basis IMMER vom Server kommt. Bei der Probe
kommt sie vom Nutzer — sie ist damit die einzige Stelle, an der ein
Angreifer die Zieladresse frei waehlt. Jeder einzelne Aufruf laeuft deshalb
durch ``pruefe_ziel_oeffentlich`` und wird an die geprueefte IP verankert;
Umleitungen werden NICHT verfolgt (anders als beim Abruf), weil eine
Umleitung hier keinen legitimen Zweck hat und nur eine zweite,
schwerer zu pruefende Adresse eroeffnen wuerde.
"""

from __future__ import annotations

import asyncio
import secrets
import urllib.parse
from dataclasses import dataclass

import httpx

from .ablage_ssrf import (
    AblageAbrufFehler,
    Resolver,
    _url_auf_adresse_verankern,
    baue_ziel_url,
    client_ctor,
    normalisiere_pfad,
    pruefe_ziel_oeffentlich,
    standard_resolver,
)

#: Muss mit ``ProbeSchritt`` in ``web/src/lib/ablage/probe.ts`` uebereinstimmen.
SCHRITTE = ("schreiben", "lesen", "vergleichen", "loeschen")

#: Praefix wie im Klienten — bleibt die Probedatei nach einem gescheiterten
#: Aufraeumen liegen, soll der Nutzer sie zuordnen koennen.
DATEINAME_PRAEFIX = "pulse-probe-"
DATEINAME_SUFFIX = ".tmp"

#: 32 Byte wie im Klienten. Gross genug, dass ein Anbieter, der stillschweigend
#: leere Dateien anlegt, beim Vergleich auffaellt.
PROBE_BYTES = 32


@dataclass(frozen=True)
class ProbeErgebnis:
    gut: bool
    schritt: str | None = None
    grund: str | None = None


def _probe_dateiname() -> str:
    return f"{DATEINAME_PRAEFIX}{secrets.token_hex(8)}{DATEINAME_SUFFIX}"


def _basis_aus_freigabe(freigabe_adresse: str) -> tuple[str, str]:
    """Zerlegt einen Nextcloud-Freigabe-Link in ``(dav_basis, token)``.

    Spiegelt ``web/src/lib/ablage/freigabeLink.ts`` — dieselbe Form, dieselbe
    DAV-Basis. Bewusst NICHT die dortige volle Formenvielfalt: hierher kommt
    nur, was der Klient bereits zerlegt und wieder zusammengesetzt hat. Passt
    etwas nicht, ist das ein 400 und keine Rateuebung.
    """
    geteilt = urllib.parse.urlsplit(freigabe_adresse)
    if geteilt.scheme not in ("http", "https") or not geteilt.hostname:
        raise AblageAbrufFehler("ziel_ungueltig")
    if geteilt.username or geteilt.password:
        raise AblageAbrufFehler("ziel_ungueltig")
    teile = geteilt.path.split("/s/")
    if len(teile) != 2:
        raise AblageAbrufFehler("kein_freigabe_link")
    token = teile[1].strip("/").split("/")[0]
    if not token:
        raise AblageAbrufFehler("kein_freigabe_link")
    basis = f"{geteilt.scheme}://{geteilt.netloc}/public.php/dav/files/{token}"
    return basis, token


async def _anfrage(
    client: httpx.AsyncClient,
    methode: str,
    url: str,
    token: str,
    resolver: Resolver,
    inhalt: bytes | None = None,
    max_bytes: int = 1024,
) -> tuple[int, bytes]:
    """Ein einzelner Aufruf gegen die GEPRUEFTE IP.

    Kein zweiter DNS-Lookup zwischen Pruefung und Verbindung — dieselbe
    Verankerung wie in ``ablage_ssrf._hole_einmal``, samt ``Host``-Kopfzeile
    und SNI, damit die Zertifikatspruefung gegen den Namen laeuft.

    Das Freigabe-Token ist der Benutzername, das Passwort ist leer — so
    definiert Nextcloud den WebDAV-Zugang eines oeffentlichen Links.
    """
    adresse = await pruefe_ziel_oeffentlich(url, resolver)
    verankert, host = _url_auf_adresse_verankern(url, adresse)
    antwort = await client.request(
        methode,
        verankert,
        headers={"Host": host},
        extensions={"sni_hostname": host},
        auth=(token, ""),
        content=inhalt,
    )
    # Der Koerper wird nur beim Lesen gebraucht und ist dort 32 Byte gross.
    # Die Schranke schuetzt vor einem Upstream, der auf ein GET etwas
    # Beliebiges zurueckschuettet.
    return antwort.status_code, antwort.content[: max_bytes + 1]


async def probiere_ziel(
    *,
    freigabe_adresse: str,
    timeout_s: float = 20.0,
    resolver: Resolver | None = None,
    http: httpx.AsyncClient | None = None,
) -> ProbeErgebnis:
    """Schreibt, liest, vergleicht und loescht eine Probedatei.

    Die Reihenfolge ist dieselbe wie im Klienten, und ``loeschen`` ist ein
    vollwertiger Schritt: ein Laufwerk, auf dem die Probedatei liegen bleibt,
    gilt als nicht bestanden — sonst sammelt der Ordner des Nutzers mit jedem
    Verbindungsversuch eine weitere Leiche.
    """
    tatsaechlicher_resolver = resolver if resolver is not None else standard_resolver
    basis, token = _basis_aus_freigabe(freigabe_adresse)
    datei = _probe_dateiname()
    url = baue_ziel_url(basis, normalisiere_pfad(datei))
    inhalt = secrets.token_bytes(PROBE_BYTES)

    eigener_client = http is None
    client = http if http is not None else client_ctor(
        timeout=timeout_s, follow_redirects=False
    )

    async def loeschen() -> ProbeErgebnis | None:
        try:
            code, _ = await _anfrage(client, "DELETE", url, token, tatsaechlicher_resolver)
        except (AblageAbrufFehler, httpx.HTTPError) as fehler:
            return ProbeErgebnis(False, "loeschen", _kennung(fehler))
        # 404 zaehlt als geloescht: das Ziel ist erreicht, und manche
        # Aufstellungen antworten so auf ein zweites DELETE.
        if code not in (200, 204, 404):
            return ProbeErgebnis(False, "loeschen", f"status_{code}")
        return None

    try:
        async with asyncio.timeout(timeout_s):
            try:
                code, _ = await _anfrage(
                    client, "PUT", url, token, tatsaechlicher_resolver, inhalt=inhalt
                )
            except (AblageAbrufFehler, httpx.HTTPError) as fehler:
                # Kein Aufraeumen: ist das Schreiben gescheitert, wurde
                # nichts sicher angelegt (gleiche Begruendung wie im Klienten).
                return ProbeErgebnis(False, "schreiben", _kennung(fehler))
            if code not in (200, 201, 204):
                return ProbeErgebnis(False, "schreiben", f"status_{code}")

            try:
                code, gelesen = await _anfrage(client, "GET", url, token, tatsaechlicher_resolver)
            except (AblageAbrufFehler, httpx.HTTPError) as fehler:
                await loeschen()
                return ProbeErgebnis(False, "lesen", _kennung(fehler))
            if code != 200:
                await loeschen()
                return ProbeErgebnis(False, "lesen", f"status_{code}")

            # ``secrets.compare_digest`` waere hier Zierde ohne Wirkung: der
            # Inhalt ist ein frisch gewuerfelter Wert ohne Geheimnisgehalt,
            # und die Gegenstelle kennt ihn bereits. Ein schlichter Vergleich
            # sagt genau das aus, was gemeint ist.
            if gelesen != inhalt:
                await loeschen()
                return ProbeErgebnis(False, "vergleichen", "inhalt_weicht_ab")

            aufraeum_fehler = await loeschen()
            if aufraeum_fehler is not None:
                return aufraeum_fehler
            return ProbeErgebnis(True)
    except TimeoutError:
        return ProbeErgebnis(False, "schreiben", "zeit_ueberschritten")
    finally:
        if eigener_client:
            await client.aclose()


def _kennung(fehler: Exception) -> str:
    """Eine kurze Kennung statt der Ausnahme selbst.

    ``str(fehler)`` einer ``httpx``-Ausnahme enthaelt regelmaessig die volle
    Adresse — und die ist hier der Schluessel. Deshalb nur die Kennung der
    eigenen Ausnahme bzw. ein Sammelbegriff.
    """
    if isinstance(fehler, AblageAbrufFehler):
        return str(fehler)
    return "upstream_nicht_erreichbar"
