"""In-process per-user token-bucket rate limiting for the chat-gateway.

This is intentionally minimal: each bucket is a sliding window keyed on
(action, user_id) held in module-global state. It is *per process* — for a
multi-instance deployment behind Caddy this must be swapped for a Redis-backed
limiter (same caveat as the auth-svc's `_check_rate`). Buckets are evicted
lazily once their window has fully elapsed, so memory stays bounded by the
number of *currently active* users.
"""

from __future__ import annotations

from time import monotonic

# action -> {user_id -> (window_start_monotonic, count)}
_buckets: dict[str, dict[int, tuple[float, int]]] = {}

# action -> (limit, window_seconds)
_RULES: dict[str, tuple[int, float]] = {
    "message": (10, 1.0),           # 10 messages / second (REST POST + WS send)
    "create_guild": (10, 60.0),     # 10 guilds / minute
    "friend_request": (10, 3600.0), # 10 friend requests / hour
    "community_invite": (30, 3600.0), # 30 community invites / hour (per inviter)
    "member_invite": (10, 3600.0),  # 10 Nutzername-Einladungen / Stunde (pro Absender)
    "report": (10, 3600.0),         # 10 reports / hour
    "attach": (20, 60.0),           # 20 upload-URL requests / minute
    "dropbox_mint": (30, 60.0),     # 30 dropbox upload-URL mints / minute
    "dropbox_folder_create": (20, 60.0), # 20 folder creates / minute
    "dropbox_finish": (60, 60.0),    # 60 finish-upload calls / minute
    "dropbox_patch": (30, 60.0),     # 30 entry patches / minute
    "dropbox_delete": (30, 60.0),    # 30 entry trash / minute
    "dropbox_restore": (20, 60.0),   # 20 entry restores / minute
    "dropbox_empty_trash": (10, 60.0), # 10 manual empty-trash / minute
    "dropbox_download": (20, 60.0),  # 20 archive/download-url mints / minute
    # Weiterreich-Abrufe (Design §4.2). Seit dem 2026-09-02 liest auch die
    # Sicherung hier: eine Wiederherstellung holt JEDES Segment und jeden
    # Anhang einzeln, und die Anhang-Spiegelung prueft vor jedem Schreiben
    # per Lesen, ob die Datei schon liegt. Mit 30/Minute kroch ein Archiv
    # mit 200 Dateien sieben Minuten, und der Rest lief in 429 — was die
    # Sicherung als „Anhang fehlt" schluckt, nicht als Drossel meldet.
    "ablage_abruf": (300, 60.0),
    "ablage_laufwerk_setzen": (10, 60.0), # 10 Freigabe-Adresse-Aenderungen / Minute
    "ablage_guild_laufwerk_setzen": (10, 60.0), # dasselbe fuer das Community-Laufwerk (E8)
    "ablage_guild_abruf": (30, 60.0), # dasselbe fuer die Community-Weiterreich-Route (E8)
    "ablage_zwischenlager_ankuendigen": (20, 60.0), # 20 Zwischenlager-Uploads / Minute (E8)
    # Die Verbindungsprobe spricht eine vom Nutzer FREI GEWAEHLTE Zieladresse
    # an — die einzige Route hier, die das tut. Sie ist deshalb knapper
    # bemessen als ihre Nachbarn: ein Mensch verbindet ein Laufwerk ein paar
    # Mal, bis der Link stimmt, und braucht dafuer keine dreissig Versuche je
    # Minute. Der SSRF-Schutz verhindert private Ziele, dieser Zaehler
    # begrenzt die Menge oeffentlicher — gegen Portscannen wirken nur beide.
    # Jeder Versuch kostet ausserdem vier Anfragen am Ziel (PUT/GET/DELETE
    # plus ggf. Aufraeumen), 6/Minute sind also bis zu 24 fremde Aufrufe.
    "ablage_pruefen": (6, 60.0),
    # Der Schreib-Weiterreicher. Grosszuegiger als die Probe: hier ist das
    # Ziel serverseitig hinterlegt und gehoert dem Aufrufer selbst, es gibt
    # also nichts zu scannen. Die Schranke begrenzt, wie schnell ein Geraet
    # sein eigenes Laufwerk vollschreiben kann. Bis zum 2026-09-02 standen
    # hier 60/Minute mit der Begruendung, der Regelbetrieb liege weit
    # darunter — das galt fuer die Ablage-Schleife (alle 30 s ein Segment),
    # nicht fuer die Sicherung, die seither ueber dieselbe Route laeuft: ihre
    # Erstsicherung schreibt Schluessel, Manifeste, Segmente und Anhaenge
    # in EINEM Schub (am Dev-Stack gemessen: 60 Treffer, dann 7 mal 429,
    # und der Rest blieb im Puffer haengen). 300/Minute bei 8 MB je Aufruf
    # bleibt eine Obergrenze fuer das eigene Laufwerk; der Klient wartet bei
    # 429 zusaetzlich mit steigenden Pausen (`ablage/geduld429.ts`).
    "ablage_schreiben": (300, 60.0),
}


def check(action: str, user_id: int) -> bool:
    """Return True if the call is allowed, False if the user is over budget.

    A side effect of every call is an opportunistic sweep of expired buckets
    for this action, which keeps the dict from growing without bound.
    """
    limit, window = _RULES[action]
    now = monotonic()
    bucket = _buckets.setdefault(action, {})

    # Lazy eviction: drop entries whose window has fully elapsed.
    if bucket:
        expired = [uid for uid, (start, _) in bucket.items() if now - start >= window]
        for uid in expired:
            del bucket[uid]

    entry = bucket.get(user_id)
    if entry is None or now - entry[0] >= window:
        bucket[user_id] = (now, 1)
        return True
    start, count = entry
    if count >= limit:
        return False
    bucket[user_id] = (start, count + 1)
    return True


def reset() -> None:
    """Clear all buckets (used by tests)."""
    _buckets.clear()
