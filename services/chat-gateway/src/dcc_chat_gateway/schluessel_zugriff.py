"""Wer darf im Geraete-Schluesselverzeichnis eines FREMDEN Kontos nachsehen.

Ausgelagert aus ``routes/schluessel.py``, weil die Regel seit dem
Schloss-Kennzeichen an ZWEI Routen haengt: ``POST /keys/claim`` (holt
Schluessel, verbraucht Vorrat) und ``GET /keys/verschluesselbar/{ziel_id}``
(sagt nur ja/nein, verbraucht nichts). Eine Kopie in beiden Modulen waere
genau die Sorte Doppelung, die spaeter auseinanderlaeuft — und hier heisst
Auseinanderlaufen: die Auskunft verraet etwas, das die Abholung
verweigert haette.
"""

from __future__ import annotations

from dcc_chat_gateway.friend_helpers import block_exists_either_way, friendship_exists
from dcc_chat_gateway.private_gruppen_zugriff import teilen_private_gruppe


async def darf_schluessel_holen(session, anfragender_id: int, ziel_id: int) -> bool:
    """Dieselbe Zugriffsregel wie beim DM-Anlegen
    (``routes/dms.py::create_or_get_dm_channel``): geblockt oder nicht
    befreundet -> keine Schluessel. Wer Schluessel fuer jemanden abholen
    kann, mit dem er gar nicht schreiben darf, koennte eine Sitzung
    aufbauen, die nie eine Nachricht tragen wird — reine Vorratsverschwendung
    und eine Moeglichkeit, den Vorrat eines Fremden leerzuziehen.

    Das eigene Konto ist immer erlaubt (weder befreundet noch geblockt
    ergibt fuer sich selbst einen Sinn) — ein Geraet holt so die Buendel der
    EIGENEN anderen Geraete, um auch fuer sie zu verschluesseln
    (Multi-Geraet-Sync).

    **Eine gemeinsame private Gruppe berechtigt ebenfalls** (Etappe G2). Ohne
    das waere eine verschluesselte Gruppe nicht baubar: der Gruppenschluessel
    reist ueber je eine 1:1-Olm-Sitzung zu jedem Geraet jedes Mitglieds, und
    dafuer braucht der Absender deren Buendel — Mitglieder einer Gruppe sind
    aber in aller Regel nicht untereinander befreundet. Die Begruendung des
    Freundschafts-Gates traegt hier nicht: mit einem Gruppenmitglied DARF man
    schreiben, die Sitzung wird also benutzt.

    **Die Blockierung geht trotzdem vor.** Wer geblockt hat, gibt keine
    Schluessel heraus, auch nicht an ein Mitglied derselben Gruppe — das
    kostet nur einen Umschlag, nicht die Gruppe: der Geblockte bleibt
    Mitglied und kann selbst weiter senden, er bekommt vom Blockierenden nur
    nichts mehr. (Beim Zustellen ist es umgekehrt gewichtet, s.
    ``routes/_postfach_deps.py::_channel_zugriff_pruefen`` — dort wuerde ein
    Ausschluss den Gruppenschluessel des Betroffenen still veralten lassen.)
    """
    if anfragender_id == ziel_id:
        return True
    if await block_exists_either_way(session, anfragender_id, ziel_id):
        return False
    if await friendship_exists(session, anfragender_id, ziel_id):
        return True
    return await teilen_private_gruppe(session, anfragender_id, ziel_id)
