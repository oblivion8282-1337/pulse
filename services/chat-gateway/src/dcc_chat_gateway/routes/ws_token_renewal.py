"""Token-Erneuerung am OFFENEN Socket — ``token_refresh``.

Warum es das gibt
-----------------
Die Lebensdauer eines Sockets war an ``exp`` seines Tokens gebunden: lief das
Token ab, schloss der Gateway mit 4001 und der Klient verband neu. Bei 900 s
Cloud-Token (``jwt_access_ttl_seconds``) bzw. 300 s Self-Host-Session-Token
hiess das: **jeder Nutzer verschwindet im festen Takt fuer ein bis zwei
Sekunden aus der Freundes- und Mitgliederliste** — der Abbau meldet beim
letzten Socket sofort ``presence_update(online=False)``, der Wiederaufbau
kostet Backoff (1 s) + Token-Refresh + ``ready``. Das war kein Netzproblem,
sondern eingebaut.

Hier wird stattdessen das *Token* am lebenden Socket ausgetauscht: der Klient
schickt vor Ablauf ein frisches, der Wecker bekommt ein neues Ziel, die
Verbindung bleibt bestehen. Es wird nichts gesendet, weil sich nichts
geaendert hat — die praeziseste Form, ein Flackern zu vermeiden.

Was die Erneuerung NICHT aufweicht
----------------------------------
Der alte Takt war nebenbei eine Sicherheitsschranke: spaetestens nach einer
Token-Lebensdauer musste jeder Socket neu durch die Eintrittspruefung in
``ws.py``. Wer die Verbindung verlaengert, verlaengert auch dieses Fenster —
deshalb prueft die Erneuerung genau die Punkte nach, die der Eintritt prueft,
und **verweigert im Zweifel**. Eine Verweigerung ist billig: der Wecker
laeuft mit dem alten ``exp`` weiter, der Socket faellt wie bisher, der Klient
verbindet neu und laeuft in die volle Eintrittspruefung (mit deren richtigem
Schliesscode). Der Rueckfall ist also der Zustand von vorher, nicht ein Loch.

Nachgeprueft wird:
  * dieselbe Nutzerkennung (``sub``),
  * unveraenderte ``admin``/``owner``-Claims — sie haengen pro Socket im
    Sichtbarkeitsfilter (``pubsub_perm_filter.py``); ein entzogener
    Admin-Status wuerde sonst unbegrenzt weiterleben statt hoechstens eine
    Token-Lebensdauer,
  * keine unbestaetigte E-Mail (``email_blocked``),
  * die Instanz ist nicht gesperrt — die Sperre wird sonst NUR beim Eintritt
    geprueft (``ws.py``), ihre Wirkung auf bestehende Sockets kam bisher
    allein daher, dass jeder Socket im Token-Takt neu eintreten musste.

Der Klient nutzt den Weg nur, wenn ``hello.capabilities`` ``token_refresh``
enthaelt — ein neuer Klient an einem alten Server faellt damit wortlos auf
den Reconnect-Weg zurueck.
"""

from __future__ import annotations

import asyncio
import logging
import time
from typing import Any

from fastapi import HTTPException, WebSocket

from dcc_chat_gateway.routes.ws_ops_registry import WSOpContext
from dcc_chat_gateway.security import decode_token
from dcc_chat_gateway.suspend_poller import read_state as read_suspend_state

log = logging.getLogger(__name__)

# Fehler-FRAME-Code (kein Schliesscode) fuer eine abgelehnte Erneuerung. Frei
# gewaehlt aus dem Fehlerframe-Block, s. Codetabelle in ``routes/ws.py``.
WS_ERR_TOKEN_REFRESH_REJECTED = 4015


class TokenExpiryWatch:
    """Schliesst den Socket, wenn sein Token ablaeuft — mit verschiebbarem Ziel.

    Der Wecker schlaeft bis ``exp`` und prueft danach **erneut**, statt sofort
    zu schliessen. Eine Erneuerung setzt nur ``exp`` weiter; der schlafende
    Faden findet das beim Aufwachen von selbst. Deshalb braucht keine
    Erneuerung ein Abbrechen und Neuanlegen der Aufgabe — und es gibt kein
    Fenster, in dem gar kein Wecker gestellt ist.
    """

    __slots__ = ("_ws", "exp", "_task")

    def __init__(self, websocket: WebSocket, exp: float) -> None:
        self._ws = websocket
        self.exp = float(exp)
        self._task = asyncio.create_task(self._run(), name="dcc-ws-token-expiry")

    async def _run(self) -> None:
        while True:
            delay = self.exp - time.time()
            if delay <= 0:
                break
            await asyncio.sleep(delay)
        try:
            await self._ws.close(code=4001, reason="token expired")
        except Exception:  # noqa: BLE001
            pass

    def renew(self, exp: float) -> None:
        """Ziel nach hinten schieben. Ein aelteres ``exp`` wird ignoriert —
        die Lebensdauer eines Sockets darf sich nie verkuerzen lassen."""
        if float(exp) > self.exp:
            self.exp = float(exp)

    def cancel(self) -> None:
        self._task.cancel()

    async def wait_cancelled(self) -> None:
        try:
            await self._task
        except (asyncio.CancelledError, Exception):  # noqa: BLE001
            pass


async def _reject(ctx: WSOpContext, msg: str) -> None:
    await ctx.websocket.send_json(
        {"op": "error", "code": WS_ERR_TOKEN_REFRESH_REJECTED, "msg": msg}
    )


async def handle_token_refresh(ctx: WSOpContext, msg: dict[str, Any]) -> None:
    """``{"op": "token_refresh", "token": "<jwt>"}`` → ``token_renewed``.

    NIEMALS das Token loggen — weder im Erfolgs- noch im Fehlerfall.
    """
    watch = ctx.token_expiry
    if watch is None:
        # Token ohne ``exp`` (nur in Tests konstruierbar) — es gibt gar keinen
        # Wecker, den man verschieben koennte.
        await _reject(ctx, "connection has no token expiry")
        return

    token = msg.get("token")
    if not isinstance(token, str) or not token:
        await _reject(ctx, "missing token")
        return

    try:
        payload = await decode_token(token)
    except (HTTPException, ValueError):
        await _reject(ctx, "invalid token")
        return

    try:
        same_user = int(payload["sub"]) == ctx.user.id
    except (KeyError, TypeError, ValueError):
        same_user = False
    if not same_user:
        await _reject(ctx, "token belongs to a different user")
        return

    if payload.get("email_blocked"):
        await _reject(ctx, "email not verified")
        return

    # Rechte-Claims muessen unveraendert sein — s. Modul-Kopf.
    if bool(payload.get("admin", False)) != ctx.user.is_admin:
        await _reject(ctx, "claims changed")
        return
    expected_owner = (not ctx.user.is_self_host) and bool(payload.get("owner", False))
    if expected_owner != ctx.user.is_owner:
        await _reject(ctx, "claims changed")
        return

    exp = payload.get("exp")
    if not isinstance(exp, (int, float)) or float(exp) <= time.time():
        await _reject(ctx, "token expired")
        return

    # Instanz-Sperre: sonst waere ein offener Socket der einzige Weg, sie zu
    # ueberdauern (s. Modul-Kopf).
    try:
        if await read_suspend_state(getattr(ctx.websocket.app.state, "redis", None)):
            await _reject(ctx, "instance suspended")
            return
    except Exception:  # noqa: BLE001
        # ``read_state`` faellt bei fehlendem Redis selbst auf „nicht gesperrt"
        # zurueck (fail-open, bewusst — s. suspend_poller.py). Ein Fehler hier
        # ist also unerwartet; wir bleiben bei derselben Linie wie der Eintritt.
        log.exception("suspend check failed during token refresh")

    watch.renew(float(exp))
    await ctx.websocket.send_json({"op": "token_renewed", "exp": float(exp)})


__all__ = [
    "TokenExpiryWatch",
    "WS_ERR_TOKEN_REFRESH_REJECTED",
    "handle_token_refresh",
]
