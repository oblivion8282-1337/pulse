"""Wire-Formen der Geraete-Kopplung (Etappe F, E2E-DM).

**Eigenes Modul statt ``schemas.py``:** jene Datei steht bei ueber 1400
Zeilen und damit weit ueber der Groessen-Policy (``PLAN.md`` §12.1) — jede
weitere Zeile dort vergroessert einen bestehenden Verstoss. ``friend_schemas.py``
ist der Praezedenzfall im selben Dienst.

**Kein Feld dieser Rumpfe traegt Geheimnisse.** ``code_hash`` ist der SHA-256
des Kopplungscodes: er taugt zum Nachschlagen, nicht zum Rueckrechnen. Der
Code selbst ueberquert diese Grenze nie — er reist ueber den Bildschirm.
``daten`` ist Chiffretext, dessen Schluessel aus dem Code abgeleitet wird;
der Server sieht ihn nie und darf ihn deshalb auch nirgends loggen.
"""

from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, Field, field_serializer

from dcc_chat_gateway.schemas import GeraeteKennung, SnowflakeId


class KopplungAnlegenRequest(BaseModel):
    """Rumpf von ``POST /kopplung`` — vom EINGERICHTETEN Geraet."""

    device_pubkey: GeraeteKennung
    #: Base64url(SHA-256) des Codes. Laengenbegrenzt, damit eine
    #: ueberlange Zeichenkette gar nicht erst in die Tabelle geraet — der
    #: Wert ist ein Hash fester Groesse, alles andere ist Unsinn.
    code_hash: str = Field(min_length=16, max_length=128)


class KopplungAnlegenResponse(BaseModel):
    id: SnowflakeId
    verfaellt_am: datetime

    @field_serializer("id")
    def _ser_id(self, v: int) -> str:
        # Snowflake-IDs gehen als STRING ueber die API — ohne diese Zeile
        # liefert FastAPI die rohe 64-Bit-Zahl, und der Browser rundet sie
        # beim Auswerten: `Number.MAX_SAFE_INTEGER` liegt bei rund 9e15, eine
        # Kopplungs-ID bei rund 8,8e16.
        #
        # Was das anrichtet, ist nicht theoretisch: der Klient schickte die
        # gerundete ID zurueck, und `POST /kopplung/stand` antwortete
        # `404 kopplung_unbekannt` auf eine Kopplung, die er Sekunden zuvor
        # selbst eingeloest hatte. Nachgemessen im Netzmitschnitt:
        # 88088470714589184 kam als 88088470714589180 zurueck. Es trifft nicht
        # jeden Lauf — nur jede Snowflake, deren letzte Ziffern beim Runden
        # verlorengehen —, und war damit genau die Sorte Fehler, die man fuer
        # Flackern haelt.
        #
        # Jedes vergleichbare Modell in `schemas.py` traegt denselben
        # Serializer; hier fehlte er als einziges.
        return str(v)


class KopplungEinloesenRequest(BaseModel):
    """Rumpf von ``POST /kopplung/einloesen`` — vom NEUEN Geraet."""

    device_pubkey: GeraeteKennung
    code_hash: str = Field(min_length=16, max_length=128)


class KopplungEinloesenResponse(BaseModel):
    id: SnowflakeId
    #: Damit das neue Geraet weiss, WESSEN Verlauf kommt — es kann den
    #: Schluessel des alten Geraets im Verzeichnis nachschlagen und dem
    #: Nutzer zeigen, mit welchem Geraet es sich gerade gekoppelt hat.
    alt_device_pubkey: str
    verfaellt_am: datetime

    @field_serializer("id")
    def _ser_id(self, v: int) -> str:
        # Snowflake-IDs gehen als STRING ueber die API — ohne diese Zeile
        # liefert FastAPI die rohe 64-Bit-Zahl, und der Browser rundet sie
        # beim Auswerten: `Number.MAX_SAFE_INTEGER` liegt bei rund 9e15, eine
        # Kopplungs-ID bei rund 8,8e16.
        #
        # Was das anrichtet, ist nicht theoretisch: der Klient schickte die
        # gerundete ID zurueck, und `POST /kopplung/stand` antwortete
        # `404 kopplung_unbekannt` auf eine Kopplung, die er Sekunden zuvor
        # selbst eingeloest hatte. Nachgemessen im Netzmitschnitt:
        # 88088470714589184 kam als 88088470714589180 zurueck. Es trifft nicht
        # jeden Lauf — nur jede Snowflake, deren letzte Ziffern beim Runden
        # verlorengehen —, und war damit genau die Sorte Fehler, die man fuer
        # Flackern haelt.
        #
        # Jedes vergleichbare Modell in `schemas.py` traegt denselben
        # Serializer; hier fehlte er als einziges.
        return str(v)


class KopplungStandRequest(BaseModel):
    """Rumpf von ``POST /kopplung/stand`` — von BEIDEN Geraeten.

    Fuer den Sender ist die Antwort die Fortsetz-Auskunft („welche Stuecke
    liegen schon?"), fuer den Empfaenger die Fortschritts-Auskunft.
    """

    device_pubkey: GeraeteKennung
    kopplung_id: SnowflakeId


class KopplungStandResponse(BaseModel):
    id: SnowflakeId
    eingeloest: bool
    #: ``None``, solange niemand eingeloest hat.
    neu_device_pubkey: str | None
    #: ``None``, solange das alte Geraet die Gesamtzahl nicht gemeldet hat.
    gesamt_stuecke: int | None
    #: Die Positionen, die bereits auf dem Server liegen — aufsteigend.
    #: **Die ganze Fortsetzbarkeit haengt an dieser Liste**: der Sender
    #: schiebt genau das, was fehlt, statt von vorne zu beginnen.
    vorhandene_stuecke: list[int]
    #: Position -> Inhalts-Kennung (nur wo eine hinterlegt ist). Der Sender
    #: vergleicht sie mit der lokal neu berechneten, um ein Stueck zu
    #: erkennen, dessen Inhalt sich seit dem letzten Lauf geaendert hat
    #: (bearbeitete/geloeschte Nachricht waehrend der offenen Frist,
    #: s. ``web/src/lib/kopplung/senden.ts``) — nur die Positionszahl allein
    #: haette das NICHT angezeigt.
    vorhandene_kennungen: dict[int, str]
    verfaellt_am: datetime


    @field_serializer("id")
    def _ser_id(self, v: int) -> str:
        # Snowflake-IDs gehen als STRING ueber die API — ohne diese Zeile
        # liefert FastAPI die rohe 64-Bit-Zahl, und der Browser rundet sie
        # beim Auswerten: `Number.MAX_SAFE_INTEGER` liegt bei rund 9e15, eine
        # Kopplungs-ID bei rund 8,8e16.
        #
        # Was das anrichtet, ist nicht theoretisch: der Klient schickte die
        # gerundete ID zurueck, und `POST /kopplung/stand` antwortete
        # `404 kopplung_unbekannt` auf eine Kopplung, die er Sekunden zuvor
        # selbst eingeloest hatte. Nachgemessen im Netzmitschnitt:
        # 88088470714589184 kam als 88088470714589180 zurueck. Es trifft nicht
        # jeden Lauf — nur jede Snowflake, deren letzte Ziffern beim Runden
        # verlorengehen —, und war damit genau die Sorte Fehler, die man fuer
        # Flackern haelt.
        #
        # Jedes vergleichbare Modell in `schemas.py` traegt denselben
        # Serializer; hier fehlte er als einziges.
        return str(v)


class UmzugStueckRequest(BaseModel):
    """Rumpf von ``POST /kopplung/stueck`` — vom ALTEN Geraet."""

    device_pubkey: GeraeteKennung
    kopplung_id: SnowflakeId
    folge: int = Field(ge=0)
    #: Base64 des AES-GCM-Chiffretexts (IV vorangestellt). Der Server kann
    #: ihn nicht oeffnen und loggt ihn nirgends.
    daten: str
    #: Base64url(HMAC-SHA256) ueber den Klartext dieses Stuecks, Schluessel
    #: per HKDF aus dem Kopplungscode (eigener Kontext, getrennt vom
    #: Transportschluessel). Dient nur dem SENDER als spaeterer Abgleich
    #: (s. ``models/kopplung.py::UmzugStueck.kennung``) und traegt keine
    #: eigene Berechtigung — wer sie setzen darf, entscheidet allein die
    #: Rollenpruefung ``alt`` in ``routes/kopplung_umzug.py``.
    kennung: str = Field(min_length=16, max_length=128)


class UmzugStueckHolenRequest(BaseModel):
    """Rumpf von ``POST /kopplung/stueck/holen`` — vom NEUEN Geraet."""

    device_pubkey: GeraeteKennung
    kopplung_id: SnowflakeId
    folge: int = Field(ge=0)


class UmzugStueckResponse(BaseModel):
    folge: int
    daten: str


class KopplungFertigRequest(BaseModel):
    """Rumpf von ``POST /kopplung/fertig`` — vom ALTEN Geraet.

    Meldet, wie viele Stuecke der Umzug insgesamt hat. Erst danach kann der
    Empfaenger wissen, ob er alles hat — ohne diese Meldung sieht ein
    Abbruch mitten im Schieben genauso aus wie ein fertiger Umzug.
    """

    device_pubkey: GeraeteKennung
    kopplung_id: SnowflakeId
    gesamt_stuecke: int = Field(ge=0)


class KopplungAbschliessenRequest(BaseModel):
    """Rumpf von ``POST /kopplung/abschliessen`` — von BEIDEN Geraeten.

    Loescht Kopplung und Stuecke. Auch das alte Geraet darf abbrechen: wer
    einen Code versehentlich gezeigt hat, muss ihn zuruecknehmen koennen,
    ohne die Frist abzuwarten.
    """

    device_pubkey: GeraeteKennung
    kopplung_id: SnowflakeId
