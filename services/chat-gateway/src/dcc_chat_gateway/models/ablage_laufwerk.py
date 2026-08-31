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

from sqlalchemy import BigInteger, DateTime, ForeignKey, Text, func
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
