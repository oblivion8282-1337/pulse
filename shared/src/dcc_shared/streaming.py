"""Shared HQ-streaming limits.

One user may run several HQ screen streams at once, told apart by a *slot*
index that rides along on the stream token, the MediaMTX path and the
``stream:active`` key (see ``dcc_media_svc.streamkeys`` for the path/key
shapes). Two services validate that index — chat-gateway when it hands a
stream-token request on, media-svc when it mints the token — so the ceiling has
to be one number, not two.

**Why this lives in ``dcc_shared`` while the Redis key NAMES deliberately do
not**: the "these services share no code on purpose" rule (CLAUDE.md,
``streamkeys.py``) is about media-svc ↔ **mediamtx-auth-hook**, and the
auth-hook is the one service with no ``dcc-shared`` dependency at all — it
cannot import this. chat-gateway and media-svc already depend on
``dcc-shared`` and already meet in it for the streaming event contracts
(``dcc_shared.events.StreamDescriptor``), so a second, drifting copy of this
bound would buy nothing. A too-low copy in either service is a silent bug: the
token route mints a slot the other half then rejects.

The clients carry their own copy of ``MAX_SLOTS`` — ``MAX_STREAM_SLOTS`` in
``web/src/lib/stream/state.svelte.ts`` and ``desktop/electron/sidecar.ts``.
There is no import path from TypeScript into Python, so that pair stays a
manual sync, the same convention the repo already uses for ``preload.ts`` ↔
``pulse.d.ts`` and the permission bitfields.
"""

from __future__ import annotations

# How many concurrent HQ streams one user may run (slots 0..MAX_SLOTS-1).
#
# Deliberately far above anything sensible: nobody has 99 monitors, and what a
# machine can really push is decided by its encoder and its uplink, not by a
# number here. The ceiling exists so a malformed request cannot mint a path
# with an unbounded slot index — it is a sanity bound, not a policy. Because of
# that, nothing may cost anything per *possible* slot; where a loop over the
# whole range is unavoidable it is called out at the site.
MAX_SLOTS = 99

# Highest legal slot index — the form the request validators want.
SLOT_MAX = MAX_SLOTS - 1


# ---- Lese-Token je Zuschauer ----------------------------------------------

# Nachschlage-Schluessel fuer das WHEP-Lese-Token EINES Zuschauers auf EINEN
# Stream. media-svc legt ihn beim Ausstellen an (``GET /whep``), damit ein
# Zuschauer im Wiederverbinden nicht bei jedem Anlauf ein frisches Token
# bekommt.
#
# **Warum er hier steht und nicht nur in media-svc**: seit 2026-08-13 muss ihn
# auch chat-gateway kennen. Wer aus einer Community entfernt oder gebannt wird,
# behielt sein Lese-Token sonst bis zu einer Stunde — es ist an Kanal und
# Streamer gebunden, nicht an ihn, und wird nicht verbraucht. Er konnte also
# weiterschauen und die Adresse weitergeben (Bughunt 2026-08-13). Der Bann
# loescht das Token deshalb aktiv, und dafuer braucht der Gateway die Form.
#
# Dieselbe Begruendung wie oben fuer ``MAX_SLOTS``: der mediamtx-auth-hook, um
# dessentwillen die Schluesselnamen sonst bewusst doppelt gefuehrt werden, kennt
# diesen Schluessel gar nicht — er liest nur ``stream:token:<token>``. Eine
# dritte Kopie in chat-gateway waere also kein bewusst getrennter Stand, sondern
# eine stille Fehlerquelle: aendert media-svc die Form, sperrt der Bann
# lautlos nichts mehr.
READ_CACHE_KEY = "stream:read-cache:{viewer_id}:{channel_id}:{user_id}:{slot}"

# Der Token-Datensatz selbst. Aus demselben Grund hier: der Bann muss ihn
# loeschen, nicht nur den Nachschlage-Schluessel oben — sonst gilt das bereits
# ausgehaendigte Token weiter und der Bann meldet trotzdem Erfolg. media-svc
# reicht diese Form in ``streamkeys.py`` nur noch durch; der mediamtx-auth-hook
# behaelt seine eigene Kopie (keine ``dcc-shared``-Abhaengigkeit, siehe dort).
TOKEN_KEY = "stream:token:{token}"


def token_key(token: str) -> str:
    return TOKEN_KEY.format(token=token)


def read_cache_key(viewer_id: str, channel_id: str, user_id: str, slot: int | str) -> str:
    """Der Nachschlage-Schluessel fuer genau ein (Zuschauer, Kanal, Streamer,
    Platz)."""
    return READ_CACHE_KEY.format(
        viewer_id=viewer_id, channel_id=channel_id, user_id=user_id, slot=slot
    )


def read_cache_scan_pattern(viewer_id: str) -> str:
    """Suchmuster fuer ``SCAN``: alle Lese-Token EINES Zuschauers.

    Der Doppelpunkt ist literal, deshalb trennt das Muster ``4`` sauber von
    ``42`` — Praefix-Kollision ausgeschlossen.

    Das Muster geht ueber **alle** Communities: die Community steht nicht im
    Schluessel, nur der Kanal. Wer auf eine Community eingrenzen will, filtert
    die Treffer mit ``read_cache_channel()`` gegen deren Kanalliste — so macht
    es der Bann-Pfad in chat-gateway.
    """
    return f"stream:read-cache:{viewer_id}:*"


def read_cache_channel(key: bytes | str) -> str:
    """Den Kanal aus einem Lese-Token-Schluessel zurueckholen; ``""`` wenn die
    Form nicht passt.

    Gehoert neben ``read_cache_key()``, weil beide dieselbe Form kennen: ein
    informeller Nachbau anderswo (etwa ein fester Index) faellt bei einer
    Formaenderung lautlos aus und laesst den Bann ins Leere greifen.
    """
    text = key.decode() if isinstance(key, bytes) else key
    teile = text.split(":")
    # "stream", "read-cache", viewer, channel, user, slot
    return teile[3] if len(teile) == 6 and text.startswith("stream:read-cache:") else ""
