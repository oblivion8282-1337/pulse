"""``/me/recovery-package`` — das Wiederherstellungs-Päckchen (Ablage §8).

Nicht zu verwechseln mit ``routes_recovery.py`` (Passwort-Reset +
E-Mail-Verifikation, unauthentifiziert). Hier geht es um einen
undurchsichtigen Block, den der Client selbst verschlüsselt hat — der
Server sieht nie den Inhalt, nur ``ciphertext`` als base64-Text.

**Nur der Konto-Eigentümer.** Alle drei Routen hängen an
``_get_current_user`` (Bearer ODER ``pulse_session``-Cookie) und lesen/
schreiben ausschliesslich die Zeile mit ``user_id == current.id`` — kein
Admin-Pfad, keine Instanz-Verwaltung, keine Fremdzugriffe.

**Nie loggen.** Weder ``ciphertext`` noch seine Länge zusammen mit der
Konto-Kennung — beides zusammen liesse Rückschlüsse auf Anzahl/Grösse der
Ablage-Verbindungen eines Kontos zu. Fehlerpfade unten geben deshalb nur den
Statuscode zurück, nie Nutzdaten.

**Löschen des Kontos.** Das Päckchen räumt sich selbst ab: ``RecoveryPackage
.user_id`` trägt ``ForeignKey(..., ondelete="CASCADE")`` — dieselbe Kaskade,
die ``BackupCode``/``WebAuthnCredential`` beim ``DELETE FROM users`` in
``routes_account.py`` mitnimmt. Kein eigener Aufräum-Schritt nötig.
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from sqlalchemy import delete

from dcc_auth.config import get_settings
from dcc_auth.db import SessionDep
from dcc_auth.models import User
from dcc_auth.models_recovery_package import RecoveryPackage
from dcc_auth.routes import _check_rate, _get_current_user
from dcc_auth.schemas import RecoveryPackageIn, RecoveryPackageOut

router = APIRouter()


@router.put("/me/recovery-package", response_model=RecoveryPackageOut)
async def put_recovery_package(
    payload: RecoveryPackageIn,
    request: Request,
    session: SessionDep,
    current: Annotated[User, Depends(_get_current_user)],
) -> RecoveryPackageOut:
    """Ablegen ODER ersetzen — ein Päckchen je Konto, ``user_id`` ist PK.

    Kein separates "existiert schon?" nötig: ``session.get`` + Insert-oder-
    Mutieren-in-einer-Transaktion reicht, weil genau ein Request diesen
    Primärschlüssel gleichzeitig sinnvoll schreibt (der aufrufende Nutzer
    ersetzt sein eigenes Päckchen — kein Wettlauf mit sich selbst, den es
    lohnte, extra zu härten).
    """
    settings = get_settings()
    await _check_rate(request, "recovery_package_write", settings.rate_limit_recovery_package)

    now = datetime.now(UTC)
    row = await session.get(RecoveryPackage, current.id)
    if row is None:
        row = RecoveryPackage(user_id=current.id, ciphertext=payload.ciphertext)
        session.add(row)
    else:
        row.ciphertext = payload.ciphertext
        row.updated_at = now
    await session.commit()
    await session.refresh(row)
    return RecoveryPackageOut(ciphertext=row.ciphertext, updated_at=row.updated_at)


@router.get("/me/recovery-package", response_model=RecoveryPackageOut)
async def get_recovery_package(
    request: Request,
    session: SessionDep,
    current: Annotated[User, Depends(_get_current_user)],
) -> RecoveryPackageOut:
    """Holen — 404 (kein Leak über den Statuscode nötig: der Aufrufer kennt
    sein eigenes Konto bereits) wenn noch nie eines abgelegt wurde. Die
    Oberfläche muss diesen Fall von "Code falsch" und "Laufwerk antwortet
    nicht" unterscheiden können (Aufgabe 4) — daher ein eigener 404-Tag statt
    eines nackten 404."""
    settings = get_settings()
    await _check_rate(request, "recovery_package_read", settings.rate_limit_recovery_package)

    row = await session.get(RecoveryPackage, current.id)
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="no_recovery_package")
    return RecoveryPackageOut(ciphertext=row.ciphertext, updated_at=row.updated_at)


@router.delete("/me/recovery-package", status_code=status.HTTP_204_NO_CONTENT)
async def delete_recovery_package(
    request: Request,
    session: SessionDep,
    current: Annotated[User, Depends(_get_current_user)],
) -> Response:
    """Löschen — das ist der Widerruf, wenn der Satz abhandenkommt (Aufgabe 4:
    "erneuern" ist client-seitig ein PUT mit neuem ``ciphertext``; ein
    reines DELETE räumt nur auf, ohne dass sofort ein neues Päckchen entsteht).
    Idempotent — Löschen einer nicht vorhandenen Zeile ist kein Fehler."""
    settings = get_settings()
    await _check_rate(request, "recovery_package_write", settings.rate_limit_recovery_package)

    await session.execute(delete(RecoveryPackage).where(RecoveryPackage.user_id == current.id))
    await session.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)
