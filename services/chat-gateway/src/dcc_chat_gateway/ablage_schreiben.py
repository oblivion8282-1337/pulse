"""Chiffrat auf ein Ablage-Laufwerk legen — der Schreib-Weiterreicher.

**Das fehlende Gegenstueck.** Der Entwurf teilt die Wege klar auf: lesen
darf der Klient direkt, **schreiben laeuft ueber Pulse** (§1, §4.0a). Fuers
Lesen gab es den Umweg seit Etappe E7 (``ablage_ssrf.hole``, Route
``GET .../ablage/abruf``) samt Rueckfall-Adapter im Klienten. Fuers
Schreiben gab es ihn **nicht** — der Klient schrieb direkt oder gar nicht.

Bei Nextcloud heisst „direkt" im Browser: gar nicht. Am 2026-09-01 an einer
echten Instanz gemessen: weder auf die Vorabfrage noch auf das echte ``PUT``
kommt eine ``Access-Control-Allow-Origin``-Kopfzeile zurueck, obwohl
derselbe Aufruf serverseitig 201 liefert. Der volle Durchlauf lief deshalb
bis zur letzten Stufe sauber — Kanal angelegt, Laufwerk verbunden,
verschluesselte Nachricht zugestellt und gelesen — und der Cloud-Ordner
blieb **leer**, ohne dass irgendwo ein Fehler sichtbar wurde.

**Nur der Besitzer des Laufwerks schreibt.** Das ist keine Verschaerfung
gegenueber dem Lesen, sondern die Bauform der Ablage: den Verlauf festigt
das Geraet des Erstellers, Mitglieder liefern ins Postfach bzw. ins
Zwischenlager. Ein Mitglied, das hier schreiben duerfte, koennte fremdes
Chiffrat ueberschreiben — der Ordner kennt keine Versionen.

**Was hier NICHT geprueft wird: der Inhalt.** Der Server sieht Chiffrat und
soll es auch bleiben lassen. Er prueft Herkunft (Besitzer), Ziel (SSRF),
Groesse und Menge — nicht, was in den Bytes steht.

**Keine Zugangsdaten, und das ist gemessen, nicht geraten.** Bei einem
Nextcloud-Freigabe-Link steckt das Token im Pfad
(``/public.php/dav/files/<token>/…``); ein ``PUT`` ohne jede
``Authorization``-Kopfzeile antwortet mit 201 (2026-09-01 geprueft). Genau
darum kommt auch die Lese-Route (``ablage_ssrf._hole_einmal``) ohne aus.
Der Server haelt damit ueberhaupt kein Geheimnis in der Hand ausser der
Adresse selbst — was ein Geheimnis genug ist:

**Die Adresse ist ein Schluessel in Textform** und kommt ausschliesslich aus
der Datenbankzeile, nie vom Aufrufer. Sie wird nicht geloggt und nicht
gespiegelt; Fehler tragen Kennungen, keine Adressen.
"""

from __future__ import annotations

import asyncio
import re
import urllib.parse

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

#: Ein Log-Segment ist klein — der Klient schneidet lange bevor das erreicht
#: waere. Die Schranke faengt einen Fehler im Klienten ab, nicht den
#: Regelbetrieb; sie ist deshalb grosszuegig und trotzdem endlich.
MAX_SCHREIB_BYTES = 8 * 1024 * 1024


async def schreibe(
    *,
    basis: str,
    pfad: str,
    inhalt: bytes,
    timeout_s: float = 30.0,
    resolver: Resolver | None = None,
    http: httpx.AsyncClient | None = None,
) -> None:
    """Legt ``inhalt`` unter ``pfad`` relativ zu ``basis`` ab.

    ``basis`` kommt IMMER vom Server (der gespeicherten Freigabe-Adresse),
    ``pfad`` ist der einzige vom Aufrufer gelieferte Teil und laeuft durch
    ``normalisiere_pfad`` — dieselbe Regel wie beim Abruf.

    **Umleitungen werden nicht verfolgt.** Beim Abruf ist eine Umleitung
    harmlos genug, um sie einmal zu erlauben; hier wuerde sie bedeuten, dass
    der Inhalt an eine zweite, nachtraeglich benannte Adresse geht. Ein
    Schreibziel, das der Server nicht vorher geprueft hat, gibt es nicht.
    """
    if len(inhalt) > MAX_SCHREIB_BYTES:
        raise AblageAbrufFehler("inhalt_zu_gross")

    tatsaechlicher_resolver = resolver if resolver is not None else standard_resolver
    url = baue_ziel_url(basis, normalisiere_pfad(pfad))

    eigener_client = http is None
    client = http if http is not None else client_ctor(
        timeout=timeout_s, follow_redirects=False
    )
    try:
        async with asyncio.timeout(timeout_s):
            adresse = await pruefe_ziel_oeffentlich(url, tatsaechlicher_resolver)
            verankert, host = _url_auf_adresse_verankern(url, adresse)
            antwort = await client.request(
                "PUT",
                verankert,
                headers={"Host": host},
                extensions={"sni_hostname": host},
                content=inhalt,
            )
            if antwort.status_code in (301, 302, 303, 307, 308):
                raise AblageAbrufFehler("umleitung_beim_schreiben")
            # 200/201/204 decken die Antworten ab, die WebDAV-Aufstellungen
            # auf ein erfolgreiches PUT geben (neu angelegt bzw. ersetzt).
            if antwort.status_code not in (200, 201, 204):
                raise AblageAbrufFehler("upstream_fehler")
    except TimeoutError as exc:
        raise AblageAbrufFehler("zeit_ueberschritten") from exc
    except httpx.HTTPError as exc:
        raise AblageAbrufFehler("upstream_nicht_erreichbar") from exc
    finally:
        if eigener_client:
            await client.aclose()


async def liste(
    *,
    basis: str,
    timeout_s: float = 30.0,
    resolver: Resolver | None = None,
    http: httpx.AsyncClient | None = None,
) -> list[str]:
    """Die Dateinamen im Laufwerks-Ordner, per WebDAV-``PROPFIND``.

    **Warum auch das ueber den Server muss.** ``PROPFIND`` ist keine
    einfache Anfrage im Sinne von CORS — der Browser schickt eine Vorabfrage,
    und die scheitert an derselben Wand wie das Schreiben. Die
    Bestandsaufnahme vor jedem Festigen (``nachzug.ts::nimmBestandAuf``)
    beginnt aber genau damit; ohne diese Route kam sie nie ueber die erste
    Zeile hinaus.

    **Nur Namen, keine Metadaten.** Groesse, Zeitstempel und Rechte gehen den
    Klienten nichts an — er ordnet ueber die Namen. Was hier nicht
    zurueckkommt, kann auch nicht versehentlich in ein Log geraten.

    Ein Ordner, den es noch nicht gibt (404), ist eine leere Liste und kein
    Fehler: beim allerersten Festigen ist das der Normalfall.
    """
    tatsaechlicher_resolver = resolver if resolver is not None else standard_resolver
    url = basis if basis.endswith("/") else f"{basis}/"

    eigener_client = http is None
    client = http if http is not None else client_ctor(
        timeout=timeout_s, follow_redirects=False
    )
    try:
        async with asyncio.timeout(timeout_s):
            adresse = await pruefe_ziel_oeffentlich(url, tatsaechlicher_resolver)
            verankert, host = _url_auf_adresse_verankern(url, adresse)
            antwort = await client.request(
                "PROPFIND",
                verankert,
                headers={"Host": host, "Depth": "1"},
                extensions={"sni_hostname": host},
            )
            if antwort.status_code == 404:
                return []
            if antwort.status_code not in (200, 207):
                raise AblageAbrufFehler("upstream_fehler")
            return _namen_aus_propfind(antwort.text, url)
    except TimeoutError as exc:
        raise AblageAbrufFehler("zeit_ueberschritten") from exc
    except httpx.HTTPError as exc:
        raise AblageAbrufFehler("upstream_nicht_erreichbar") from exc
    finally:
        if eigener_client:
            await client.aclose()


def _namen_aus_propfind(xml: str, basis_url: str) -> list[str]:
    """Zieht die Dateinamen aus einer ``PROPFIND``-Antwort.

    Bewusst mit einem Regex statt einem XML-Parser: die Antwort kommt von
    einer fremden Gegenstelle, und Pythons XML-Parser sind gegen boesartige
    Eingaben (Entity-Expansion, externe Entities) nur mit Zusatzarbeit
    abzusichern. Gebraucht wird hier eine einzige Feldart; ein Regex kann an
    dieser Aufgabe nichts falsch machen, was ein Parser besser koennte, und
    er kann nichts aufloesen, was er nicht soll.

    **Ordner fallen weg** (Eintraege mit Schraegstrich am Ende) und der
    Ordner selbst ebenfalls — der Klient erwartet Dateinamen, keine Pfade.
    """
    eigener_pfad = urllib.parse.urlsplit(basis_url).path.rstrip("/")
    namen: list[str] = []
    for roh in re.findall(r"<[a-zA-Z0-9]*:?href>([^<]*)</[a-zA-Z0-9]*:?href>", xml):
        pfad = urllib.parse.unquote(roh)
        if pfad.rstrip("/") == eigener_pfad:
            continue
        if pfad.endswith("/"):
            continue
        name = pfad.rsplit("/", 1)[-1]
        if name:
            namen.append(name)
    return namen
