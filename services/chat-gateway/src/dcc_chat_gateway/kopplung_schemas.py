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

from pydantic import BaseModel, Field

from dcc_chat_gateway.schemas import SnowflakeId


class KopplungAnlegenRequest(BaseModel):
    """Rumpf von ``POST /kopplung`` — vom EINGERICHTETEN Geraet."""

    cert: str
    #: Base64url(Ed25519) ueber ``baue_nutzlast("kopplung", code_hash)``.
    signatur: str
    #: Base64url(SHA-256) des Codes. Laengenbegrenzt, damit eine
    #: ueberlange Zeichenkette gar nicht erst in die Tabelle geraet — der
    #: Wert ist ein Hash fester Groesse, alles andere ist Unsinn.
    code_hash: str = Field(min_length=16, max_length=128)


class KopplungAnlegenResponse(BaseModel):
    id: SnowflakeId
    verfaellt_am: datetime


class KopplungEinloesenRequest(BaseModel):
    """Rumpf von ``POST /kopplung/einloesen`` — vom NEUEN Geraet."""

    cert: str
    #: Base64url(Ed25519) ueber ``baue_nutzlast("kopplung-einloesen", code_hash)``.
    signatur: str
    code_hash: str = Field(min_length=16, max_length=128)


class KopplungEinloesenResponse(BaseModel):
    id: SnowflakeId
    #: Damit das neue Geraet weiss, WESSEN Verlauf kommt — es kann den
    #: Schluessel des alten Geraets im Verzeichnis nachschlagen und dem
    #: Nutzer zeigen, mit welchem Geraet es sich gerade gekoppelt hat.
    alt_device_pubkey: str
    verfaellt_am: datetime


class KopplungStandRequest(BaseModel):
    """Rumpf von ``POST /kopplung/stand`` — von BEIDEN Geraeten.

    Fuer den Sender ist die Antwort die Fortsetz-Auskunft („welche Stuecke
    liegen schon?"), fuer den Empfaenger die Fortschritts-Auskunft.
    """

    cert: str
    #: Base64url(Ed25519) ueber ``baue_nutzlast("kopplung-stand", kopplung_id)``.
    signatur: str
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
    verfaellt_am: datetime


class UmzugStueckRequest(BaseModel):
    """Rumpf von ``POST /kopplung/stueck`` — vom ALTEN Geraet."""

    cert: str
    #: Base64url(Ed25519) ueber
    #: ``baue_nutzlast("kopplung-stueck", kopplung_id, folge, daten)``.
    signatur: str
    kopplung_id: SnowflakeId
    folge: int = Field(ge=0)
    #: Base64 des AES-GCM-Chiffretexts (IV vorangestellt). Der Server kann
    #: ihn nicht oeffnen und loggt ihn nirgends.
    daten: str


class UmzugStueckHolenRequest(BaseModel):
    """Rumpf von ``POST /kopplung/stueck/holen`` — vom NEUEN Geraet."""

    cert: str
    #: Base64url(Ed25519) ueber
    #: ``baue_nutzlast("kopplung-stueck-holen", kopplung_id, folge)``.
    signatur: str
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

    cert: str
    #: Base64url(Ed25519) ueber
    #: ``baue_nutzlast("kopplung-fertig", kopplung_id, gesamt_stuecke)``.
    signatur: str
    kopplung_id: SnowflakeId
    gesamt_stuecke: int = Field(ge=0)


class KopplungAbschliessenRequest(BaseModel):
    """Rumpf von ``POST /kopplung/abschliessen`` — von BEIDEN Geraeten.

    Loescht Kopplung und Stuecke. Auch das alte Geraet darf abbrechen: wer
    einen Code versehentlich gezeigt hat, muss ihn zuruecknehmen koennen,
    ohne die Frist abzuwarten.
    """

    cert: str
    #: Base64url(Ed25519) ueber ``baue_nutzlast("kopplung-abschliessen", kopplung_id)``.
    signatur: str
    kopplung_id: SnowflakeId
