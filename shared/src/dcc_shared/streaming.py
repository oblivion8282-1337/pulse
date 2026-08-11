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
