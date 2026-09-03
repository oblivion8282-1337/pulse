"""Die Freigabe-Adresse eines Ablage-Kanals (Design §4.1/§4.2, Etappe E7).

Ein Ablage-Kanal (``Channel.ablage == True``) liegt auf dem Cloud-Laufwerk
seines Erstellers. Damit Mitglieder den Verlauf lesen koennen, obwohl ihr
Browser die fremde Cloud wegen CORS nicht direkt erreicht (an einer echten
Nextcloud gemessen, §4.2), haelt der Server je Kanal EINE Adresse — einen
Schreib-Link, den nur er kennt und nur zum Weiterreichen benutzt
(``routes/ablage_kanal.py``).

**Eigene Tabelle statt Spalte an ``channels``.** Drei Gruende:

1. Die Adresse ist ein Schluessel in fremder Hand (Design §2.3/§4.0): sie
   darf nie in einer normalen Kanal-Antwort auftauchen. Eine eigene Tabelle,
   die kein Route je in ``ChannelOut``/``_channel_dict`` einliest, macht das
   strukturell statt durch Disziplin an jeder Serialisierungsstelle.
2. Nur Ablage-Kanaele haben ueberhaupt eine — eine Spalte an ``channels``
   waere fuer die grosse Mehrheit der Zeilen NULL.
3. ``Channel`` traegt bisher gar keinen Ersteller (anders als
   ``Guild.creator_id`` oder ``PrivateGroupChannel.ersteller_id``). Die
   Regel „nur der Ersteller darf sie setzen" (§4.0) braucht diesen Begriff
   aber nur HIER — deshalb ``ersteller_id`` in dieser Tabelle statt eine
   generische Kanal-Spalte, die jede andere Kanalart nie braucht.
   ``ersteller_id`` ist, wer die Zeile zuerst angelegt hat: der
   Primaerschluessel auf ``channel_id`` macht das erste erfolgreiche INSERT
   atomar zur Festlegung, ohne Sperre.

``ON DELETE CASCADE`` auf ``channels.id`` — verschwindet der Kanal, verliert
die Adresse jeden Sinn.
"""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import BigInteger, DateTime, ForeignKey, Integer, Text, func, text
from sqlalchemy.orm import Mapped, mapped_column

from dcc_chat_gateway.db import Base


class AblageKanalLaufwerk(Base):
    __tablename__ = "ablage_kanal_laufwerke"

    channel_id: Mapped[int] = mapped_column(
        BigInteger,
        ForeignKey("channels.id", ondelete="CASCADE"),
        primary_key=True,
    )
    # Wer die Zeile zuerst angelegt hat — s. Klassen-Docstring. Nur er darf
    # ``freigabe_adresse`` danach ersetzen (``routes/ablage_kanal.py``).
    ersteller_id: Mapped[int] = mapped_column(BigInteger, nullable=False)
    # Der Schreib-Link. NIE an einen Klienten zurueckgeben, NIE loggen (Design
    # §4.0) — der Server sieht ihn nur, um damit selbst eine Anfrage zu
    # stellen (``ablage_ssrf.py``). Text statt String: manche Anbieter-Links
    # (Google-Drive-Freigaben) sind laenger als ein knapper VARCHAR bequem
    # fasst, und eine Obergrenze schuetzt hier nichts.
    freigabe_adresse: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        onupdate=func.now(),
        nullable=False,
    )


class AblageGuildLaufwerk(Base):
    """Die Freigabe-Adresse des Community-Laufwerks (Etappe E8, Design §7).

    **Eigene Tabelle statt eines gemeinsamen Bezugstyps** (``kanal``/``guild``
    an einer geteilten Zeile) — drei Gruende, dieselbe Abwaegung wie beim
    Kanal-Pendant oben, mit einem zusaetzlichen:

    1. Dieselbe Geheimhaltungs-Anforderung wie beim Kanal: die Adresse darf
       strukturell nie in einer ``GuildOut`` landen. Eine gemeinsame Tabelle
       mit einer ``bezug_typ``-Spalte muesste diese Garantie durch Disziplin
       an jeder Leseabfrage erkaufen (,,filter nach Typ nicht vergessen");
       zwei getrennte Tabellen erzwingen es durch die Modellgrenze selbst.
    2. ``Guild`` hat, anders als ``Channel``, BEREITS einen Eigentuemer-Begriff
       (``Guild.owner_id`` — er wechselt bei Owner-Transfer). Eine geteilte
       Zeile mit einem eigenen ``ersteller_id`` wie beim Kanal waere hier ein
       zweiter, unnoetiger Begriff von ,,wem gehoert das" — die Route
       (``routes/ablage_guild_laufwerk.py``) prueft deshalb bei JEDEM Aufruf
       gegen den *aktuellen* ``Guild.owner_id``, statt einen eigenen
       ``ersteller_id`` mitzufuehren, der nach einer Eigentuemer-Uebergabe
       falsch laege. **Wichtig:** ein Owner-Wechsel macht die hier stehende
       Adresse NICHT ungueltig — sie zeigt weiter auf das Cloud-Laufwerk des
       VORHERIGEN Besitzers, bis der neue Besitzer sie ersetzt. Das ist eine
       bekannte Luecke, kein Uebersehen (E8-Bericht).
    3. Guild- und Kanal-Ablage sind unabhaengige Konzepte (E7 vs. E8) mit
       unabhaengigen Lebenszyklen — eine Community kann ein Laufwerk haben,
       ohne dass irgendein Ablage-Kanal existiert, und umgekehrt.

    ``ON DELETE CASCADE`` auf ``guilds.id`` — verschwindet die Community,
    verliert die Adresse jeden Sinn.
    """

    __tablename__ = "ablage_guild_laufwerke"

    guild_id: Mapped[int] = mapped_column(
        BigInteger,
        ForeignKey("guilds.id", ondelete="CASCADE"),
        primary_key=True,
    )
    freigabe_adresse: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        onupdate=func.now(),
        nullable=False,
    )


class AblageKontoLaufwerk(Base):
    """Das Cloud-Laufwerk des persoenlichen Archivs — eines je Konto.

    **Warum der Server sie ueberhaupt kennt.** Das persoenliche Archiv ist
    der eigene Cloud-Ordner des Nutzers, und man koennte meinen, Pulse habe
    dort nichts zu suchen. Der Grund ist derselbe wie beim Kanal-Laufwerk
    und rein technisch: ein Browser kann in eine fremde Cloud nicht
    schreiben, weil deren Server keine CORS-Kopfzeilen setzt (an einer
    echten Nextcloud gemessen). Ohne diese Zeile gaebe es das Archiv nur
    fuer den lokalen Sync-Ordner, nicht fuer eine Cloud.

    Das deckt sich mit der Entscheidung des Eigentuemers vom 2026-08-31
    („je ein Schreib-Link, den nur Pulse kennt") — es ist der dritte dieser
    drei Links, neben Kanal und Community.

    **Eines je Konto, deshalb ``user_id`` als Primaerschluessel.** Wer ein
    zweites Laufwerk eintraegt, ersetzt das erste; eine Reihe paralleler
    Archive waere ein anderes Feature und braeuchte eine Antwort darauf, in
    welches geschrieben wird.

    Kein ``ForeignKey``: die Nutzertabelle liegt im auth-Schema, und der
    chat-gateway greift nie ueber Schemagrenzen (CLAUDE.md: „Services
    kommunizieren nur ueber Redis Pub/Sub oder HTTP — niemals shared
    DB-Tabellen"). Aufgeraeumt wird beim Kontoloeschen ueber
    ``user_purge_ablage.py``.
    """

    __tablename__ = "ablage_konto_laufwerke"

    user_id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    # Wie oben: NIE zurueckgeben, NIE loggen.
    freigabe_adresse: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )


class AblageKanalOrdner(Base):
    """Kanal liegt als Ordner ``kanaele/<channel_id>/`` im Konto-Laufwerk
    seines Erstellers; der Server legt ab (Entwurf 2026-09-02, §2-3).
    Kein ``freigabe_adresse`` hier — die kommt aus ``AblageKontoLaufwerk``
    des Erstellers, es gibt EINEN Link je Konto."""

    __tablename__ = "ablage_kanal_ordner"

    channel_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("channels.id", ondelete="CASCADE"), primary_key=True
    )
    ersteller_id: Mapped[int] = mapped_column(BigInteger, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )


class AblageKanalNachtrag(Base):
    """Eine Nutzlast, deren Festigung im Kanal-Ordner noch aussteht. Fällt
    die Nutzlast, fällt der Nachtrag mit (CASCADE).

    **Die Zeile entsteht schon im Einliefer-Commit**, nicht erst nach einem
    Fehlschlag (Fixwelle 2 R1): sie ist der Marker „Festigung offen", und an
    ihm hängt der Schutz der Nutzlast vor den beiden Löschern (Quittung und
    ``sweep_verwaiste_nutzlasten``). Entstünde sie erst im Fehlerfall, hätte
    eine schnelle Quittung die Nutzlast bereits gelöscht, bevor die
    Hintergrund-Ablage sie überhaupt lesen konnte.

    ``versuche``/``naechster_versuch_at`` tragen den Wiederholungs-Abstand
    (``nachtrag_sweep``): ohne sie liefe eine dauerhaft unerreichbare Cloud
    in JEDEM Pflegetakt erneut in dieselbe Zeitüberschreitung und
    verbrauchte dabei den Stapelplatz aller anderen.
    """

    __tablename__ = "ablage_kanal_nachtrag"

    nutzlast_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("dm_nutzlasten.id", ondelete="CASCADE"), primary_key=True
    )
    channel_id: Mapped[int] = mapped_column(BigInteger, nullable=False, index=True)
    #: Wie oft das Ablegen für diese Zeile schon gescheitert ist.
    versuche: Mapped[int] = mapped_column(
        Integer, nullable=False, server_default=text("0"), default=0
    )
    #: Frühestens ab hier wieder anfassen — der Sweep filtert danach und
    #: sortiert danach, die ältesten Wartenden zuerst.
    naechster_versuch_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False, index=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
