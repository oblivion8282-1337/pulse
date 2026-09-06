"""Das Wiederherstellungs-Päckchen (Ablage-Konzept §8).

Ein Konto kann sein persönliches Ablage-Archiv mit einem einmalig gezeigten
Wiederherstellungs-Satz gegen Totalverlust absichern (alle Geräte weg = Archiv
sonst für immer Chiffrat). Das Päckchen selbst — Archiv-Hauptschlüssel +
Geräte-Identität + die Ablage-Verbindungen samt Freigabe-Links, client-seitig
mit einem aus dem Satz abgeleiteten Schlüssel verschlüsselt — liegt **auch**
in der Ablage, aber zusätzlich hier: ein frisches Gerät kennt die
gerätelokale Verbindungsliste noch nicht und kann die Ablage deshalb nicht
selbst finden. Ohne den Satz ist die Zeile für den Server wertlos — er sieht
nur einen undurchsichtigen Block.

Warum dieses Modul (und nicht ``models.py``): das dortige Modul ist bereits
über der Grössen-Policy und wächst nicht weiter mit; neue, in sich
geschlossene Tabellen bekommen ein eigenes kleines Modul (Muster:
``models_credentials.py``, ``models_instances.py``).

Warum ``auth`` und nicht ``chat-gateway``: Das Päckchen hängt am **Konto**,
nicht an einer Community/Instanz — genau wie ``BackupCode``/
``WebAuthnCredential`` in ``models.py``. auth-svc ist bereits die Stelle, die
konto-gebundene Geheimnisse hält und sie per FK-``CASCADE`` beim
``DELETE FROM users`` automatisch mitreisst; kein Cross-Service-Aufruf nötig
(anders als chat-gateway-eigene Daten, die ``routes_account.py`` erst per
internem HTTP-Aufruf abräumen lässt, BEVOR die User-Zeile fällt).
"""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import BigInteger, DateTime, ForeignKey, Text, func
from sqlalchemy.orm import Mapped, mapped_column

from dcc_auth.db import Base


class RecoveryPackage(Base):
    """Ein Päckchen je Konto — ``user_id`` ist zugleich Primärschlüssel, ein
    PUT ersetzt die bestehende Zeile also atomar (kein separates "gibt es
    schon?"-Race, ``session.get`` + Insert-oder-Update reicht).

    ``ciphertext`` ist base64-codierter Text, nicht ``LargeBinary`` — gleiches
    Muster wie ``WebAuthnCredential.public_key``: verhält sich auf Postgres
    (Prod) und SQLite (Test) identisch und bleibt in psql greppbar (auch wenn
    hier nie gegrept werden sollte, s. Routen-Kommentar zum Logging-Verbot).
    """

    __tablename__ = "recovery_packages"

    user_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
    ciphertext: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        onupdate=func.now(),
        nullable=False,
    )
