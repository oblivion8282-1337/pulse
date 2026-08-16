"""Die Bindung einer Fernsteuer-Sitzung an ein Standplatz-Gerät.

Ausgelagert aus :mod:`routes.ws_remote_handlers` (Grössen-Policy §12.1) und
inhaltlich ein eigener Gedanke: der Handshake dort beschreibt die Zustimmung,
hier steht, **wem** eine Anfrage überhaupt gelten darf.

## Der Fehlerfall, der diese Datei erzwungen hat (Bughunt 2026-08-16)

Ein Gerät mit Dauerfreigabe stimmt selbsttätig zu — es fragt niemanden, es
prüft nur, ob die Anfrage IHM gilt (``$lib/remote/geraeteanbindung.ts``). Eine
Anfrage **ohne** ``device_id`` galt ihm damit ebenfalls, und der Kanal, an dem
der Gateway die Rechte prüfte, war der, den der RUFER hineinschrieb. Wer also
irgendwo eine eigene Community hat, in der das Opfer Mitglied ist, gab sich
dort ``REMOTE_CONTROL``, nannte diesen Kanal und übernahm einen Rechner, der in
einer ganz anderen Community steht — vorbei an jedem Overwrite des echten
Standplatzes.

Der Standplatz ist der Rechteanker des Geräts (``models/devices.py``). Also:

* Eine Anfrage, die ein Gerät **nennt**, muss im Standplatz dieses Geräts
  gestellt sein — sonst 4051.
* Eine Anfrage, die **keines** nennt, erreicht keinen Geräte-Socket. Sie gilt
  einem Menschen, und ein Mensch, der gerade an einem eingetragenen Gerät
  sitzt, wird über dessen Standplatz angefragt oder gar nicht.
* Und wer zustimmt, wird beim Wort genommen: ein Geräte-Socket darf nur eine
  Sitzung annehmen, die auf seinen eigenen Standplatz zeigt. Das schliesst das
  Rennen „Gerät meldet sich an, NACHDEM die Einladung hinausging".

Die Prüfung ist **hier** verbindlich. Der Client prüft dieselbe Sache noch
einmal (er kennt seine Dauerfreigabe besser), aber ein Client ist der Teil des
Systems, der dem Angreifer gehört.
"""

from __future__ import annotations

from typing import Any

from dcc_chat_gateway.models import Device


async def standplatz_stimmt(session, device_id: int, channel_id: int) -> bool:
    """Steht das Gerät ``device_id`` wirklich im Kanal ``channel_id``?

    ``False`` auch für ein Gerät, das es gar nicht gibt — der Rufer soll aus
    der Antwort nicht ablesen können, welche Kennungen vergeben sind.
    """
    device = await session.get(Device, device_id)
    return device is not None and device.channel_id == channel_id


def einladungsziele(mgr, host_user_id: int, device_id: int | None) -> list[Any]:
    """Welche Verbindungen des Hosts die Einladung sehen dürfen.

    Mit Gerät: nur dessen angemeldete Verbindungen. Ohne Gerät: nur die, die
    **keines** angemeldet haben (Begründung im Modulkopf). Leere Liste heisst
    für den Aufrufer „Host nicht erreichbar" — die ehrliche Antwort, denn der
    Gemeinte ist es dann tatsächlich nicht.

    Holt die Socket-Liste selbst, statt sie sich reichen zu lassen: der
    Aufrufer fragt zweimal (einmal vor, einmal nach den DB-Abfragen), und
    beide Male muss sie frisch sein.
    """
    host_sockets = mgr.remote_user_sockets(host_user_id)
    if device_id is None:
        return [hs for hs in host_sockets if not mgr.device_ids_for_socket(hs)]
    return [hs for hs in host_sockets if device_id in mgr.device_ids_for_socket(hs)]


def darf_zustimmen(mgr, sess, websocket: Any) -> bool:
    """Darf diese Verbindung dieser Sitzung zustimmen?

    Für alles, was kein angemeldetes Gerät ist: ja — die Zustimmung eines
    Menschen ist genau das, was der Handshake einholt. Für ein Gerät nur dann,
    wenn die Sitzung ihm gilt und auf seinen Standplatz zeigt.
    """
    geraete = mgr.device_ids_for_socket(websocket)
    if not geraete:
        return True
    if sess.device_id is None:
        return False
    gemeint = int(sess.device_id)
    return gemeint in geraete and sess.channel_id == str(mgr.device_channel(gemeint))
