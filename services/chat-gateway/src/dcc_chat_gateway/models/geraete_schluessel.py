"""Das Verzeichnis der Verschluesselungs-Schluessel je Geraet.

Geführt wird ueber ``device_pubkey``, NICHT ueber ``cert_id``: die
Zertifikatserneuerung stellt alle 30 Tage ein neues Zertifikat fuer denselben
Pubkey aus (``cert-rotation.svelte.ts``). An der cert_id haengende Buendel
wuerden monatlich verwaisen.

``cert_id`` wird trotzdem mitgeschrieben — sie ist der Schluessel, unter dem
die Sperrliste (``auth:revoked:certs``) ein widerrufenes Geraet fuehrt.
"""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import BigInteger, DateTime, ForeignKey, Index, Text, UniqueConstraint, func
from sqlalchemy.orm import Mapped, mapped_column

from dcc_chat_gateway.db import Base


class DeviceKeyBundle(Base):
    __tablename__ = "device_key_bundles"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    user_id: Mapped[int] = mapped_column(BigInteger, nullable=False)
    #: Base64, Ed25519 — die Identitaet des Geraets, stabil ueber Erneuerungen.
    device_pubkey: Mapped[str] = mapped_column(Text, nullable=False)
    #: Base64, Curve25519 — der Schluessel, mit dem verschluesselt wird.
    curve25519: Mapped[str] = mapped_column(Text, nullable=False)
    #: Base64, Ed25519-Unterschrift des Geraets ueber sein eigenes Buendel.
    signatur: Mapped[str] = mapped_column(Text, nullable=False)
    #: Greift, wenn der Vorrat an Einmalschluesseln leer ist. Eine eigene
    #: Signatur dafuer gibt es bewusst NICHT (mehr) — ``signatur`` oben deckt
    #: ihn bereits mit ab, s. Kommentar an ``BundleVeroeffentlichenRequest``
    #: in ``schemas.py``.
    rueckfallschluessel: Mapped[str | None] = mapped_column(Text, nullable=True)
    cert_id: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    __table_args__ = (
        UniqueConstraint("user_id", "device_pubkey", name="uq_device_key_bundles_geraet"),
        Index("ix_device_key_bundles_user", "user_id"),
    )


class DeviceOneTimeKey(Base):
    __tablename__ = "device_one_time_keys"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    bundle_id: Mapped[int] = mapped_column(
        BigInteger,
        ForeignKey("device_key_bundles.id", ondelete="CASCADE"),
        nullable=False,
    )
    #: Base64, Curve25519. Wird beim Abholen GELOESCHT, nicht markiert —
    #: „einmal" ist sonst nur eine Absichtserklaerung.
    schluessel: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    __table_args__ = (
        UniqueConstraint("bundle_id", "schluessel", name="uq_device_otk"),
        Index("ix_device_otk_bundle", "bundle_id"),
    )
