"""Archiv-Schlüssel je Konto (Übergabe 2026-10-04, §5).

Der private X25519-Archiv-Schlüssel liegt ZWEIFACH gewrappt:

  * ``wrap_kdf`` — unter Argon2id(Passwort, ``kdf_salt``), clientseitig
    gerechnet (hash-wasm; Parameter t=3, m=64 MiB, p=1, 32 Bytes — die
    Server-Seite muss bei Reset-Re-Wrap EXAKT dieselben verwenden).
  * ``wrap_schrank`` — unter dem Server-Schrank-Geheimnis
    (``archiv_schrank_secret``, AES-256-GCM). NUR der Passwort-Reset-Weg
    öffnet ihn, um unter das neue Passwort neu zu wickeln — deshalb
    verliert ein E-Mail-Reset nichts (Entscheidung 03./04.10.).

``pubkey`` ist öffentlich und wird über ``/internal/archiv-schluessel/
pubkey/{user_id}`` an DM-Partner verteilt (der chat-gateway liefert ihn
nur an echte DM-Partner aus).

Ehrliche Grenze (Übergabe §5.3): ein DB-Dieb sieht nur Chiffre; ein
Ganz-Server-Dieb (Code + DB + Schrank-Geheimnis) kann 120-Tage-Texte
lesen — unvermeidbar, wenn Reset ohne Alt-Passwort öffnen können soll.
"""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import BigInteger, DateTime, LargeBinary, func
from sqlalchemy.orm import Mapped, mapped_column

from dcc_auth.db import Base


class ArchivSchluessel(Base):
    __tablename__ = "archiv_schluessel"

    user_id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    # Roh-X25519-Public-Key (32 Bytes).
    pubkey: Mapped[bytes] = mapped_column(LargeBinary, nullable=False)
    kdf_salt: Mapped[bytes] = mapped_column(LargeBinary, nullable=False)
    wrap_kdf: Mapped[bytes] = mapped_column(LargeBinary, nullable=False)
    wrap_schrank: Mapped[bytes] = mapped_column(LargeBinary, nullable=False)
    erstellt_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    geaendert_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
