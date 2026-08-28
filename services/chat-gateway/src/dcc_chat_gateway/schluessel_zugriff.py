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
    (Multi-Geraet-Sync)."""
    if anfragender_id == ziel_id:
        return True
    if await block_exists_either_way(session, anfragender_id, ziel_id):
        return False
    return await friendship_exists(session, anfragender_id, ziel_id)
