"""Per-socket friend / block caches used during pub/sub fan-out.

Extracted from :mod:`pubsub` as a mixin (Etappe 2 of the Voll-Discord friend
system). Holds the lazy-filled ``_ws_friends`` / ``_ws_blocks_out`` /
``_ws_blocks_in`` sets and the live-update logic that keeps them in sync
with the friend/block lifecycle events the REST routes publish.

State (``_ws_user``, ``_ws_friends``, ``_ws_blocks_out``, ``_ws_blocks_in``,
``_ws_pending_deltas``, ``_user_conns``, ``_lock``) is initialised in
``ConnectionManager.__init__``; the mixin reaches it via ``self.`` through
cooperative inheritance.

**Register→hydrate race:** ``routes/ws_ready.py`` registers the socket
(``manager.register``), then loads the friend/block snapshot from the DB,
then calls ``hydrate_friend_caches`` — three separate ``await`` points. A
friend/block lifecycle event for this user can land on the pub/sub listener
in that gap: the socket is already in ``_ws_user`` (so ``_apply_friend_*``
finds it), but its cache dict entry doesn't exist yet, so the old code
treated ``None`` as "not hydrated, nothing to mutate" and dropped the event
on the floor — permanently, since the *next* thing to touch the cache was
``hydrate_friend_caches`` overwriting it with the (now stale) DB snapshot.
Fix: an un-hydrated mutation is buffered per-socket in
``_ws_pending_deltas`` instead of dropped, and replayed once
``hydrate_friend_caches`` lands the snapshot. Replay uses ``set.add`` /
``set.discard`` — both idempotent — so it doesn't matter whether the
buffered delta already made it into the DB snapshot (e.g. because the event
fired between the DB read and the ``hydrate`` call rather than before it):
applying it twice is a no-op, not a double-count.
"""

from __future__ import annotations

from fastapi import WebSocket


class _FriendCacheMixin:
    """Adds the per-socket friend / block caches + presence-visibility filter
    to :class:`ConnectionManager`. Not usable standalone."""

    async def hydrate_friend_caches(
        self,
        ws: WebSocket,
        *,
        friends: set[int],
        blocks_out: set[int],
        blocks_in: set[int],
    ) -> None:
        """Seed the per-socket friend/block caches with already-loaded sets.
        Called from the WS endpoint right after ``register`` with the same
        sets the ``ready`` frame is built from — so the first lookup is
        warm. No-op for sockets that have been removed.

        Replays anything buffered in ``_ws_pending_deltas`` for this socket
        (see module docstring) on top of the snapshot, then clears the
        buffer — a lifecycle event that fired during the register→hydrate
        gap must not still be sitting there after the socket is warm."""
        async with self._lock:
            if ws not in self._ws_user:
                return
            self._ws_friends[ws] = set(friends)
            self._ws_blocks_out[ws] = set(blocks_out)
            self._ws_blocks_in[ws] = set(blocks_in)
            for cache_attr, other, add in self._ws_pending_deltas.pop(ws, ()):
                target = getattr(self, cache_attr)[ws]
                target.add(other) if add else target.discard(other)

    def friends_for(self, ws: WebSocket) -> set[int] | None:
        """Read the cached friend set for this socket (None if not hydrated)."""
        return self._ws_friends.get(ws)

    def blocks_out_for(self, ws: WebSocket) -> set[int] | None:
        return self._ws_blocks_out.get(ws)

    def blocks_in_for(self, ws: WebSocket) -> set[int] | None:
        return self._ws_blocks_in.get(ws)

    def is_blocked_by_any_socket(self, target_user_id: int, sender_user_id: int) -> bool:
        """Heuristic: True if ANY of ``target_user_id``'s open sockets has
        the cached info that ``sender_user_id`` is blocked (either side).

        Used as a fast-path before the mention fan-out: if the receiver is
        online and the cache says blocked, we can skip the DB hop entirely.
        When the cache isn't hydrated yet (no sockets / partial state) the
        caller falls back to the DB check via ``friend_events.is_blocked_between``.
        Returns False on cache miss — the DB hop catches the actual block.
        """
        socks = self._user_conns.get(target_user_id)
        if not socks:
            return False
        for ws in socks:
            blocks_out = self._ws_blocks_out.get(ws)
            blocks_in = self._ws_blocks_in.get(ws)
            if blocks_out is not None and sender_user_id in blocks_out:
                return True
            if blocks_in is not None and sender_user_id in blocks_in:
                return True
        return False

    def _mutate_or_buffer(self, ws: WebSocket, cache_attr: str, other: int, add: bool) -> None:
        """Apply an add/discard to a per-socket cache set, or — if that
        socket's cache isn't hydrated yet (register→hydrate gap, see module
        docstring) — buffer it in ``_ws_pending_deltas`` for
        ``hydrate_friend_caches`` to replay. ``cache_attr`` is the name of
        one of ``_ws_friends`` / ``_ws_blocks_out`` / ``_ws_blocks_in``."""
        store = getattr(self, cache_attr).get(ws)
        if store is not None:
            store.add(other) if add else store.discard(other)
        else:
            self._ws_pending_deltas.setdefault(ws, []).append((cache_attr, other, add))

    def _apply_friend_added(self, user_a: int, user_b: int) -> None:
        """Mutate both users' cached friend sets when a friendship is installed."""
        for ws, u in list(self._ws_user.items()):
            if u.id == user_a:
                self._mutate_or_buffer(ws, "_ws_friends", user_b, True)
            elif u.id == user_b:
                self._mutate_or_buffer(ws, "_ws_friends", user_a, True)

    def _apply_friend_removed(self, user_a: int, user_b: int) -> None:
        for ws, u in list(self._ws_user.items()):
            if u.id == user_a:
                self._mutate_or_buffer(ws, "_ws_friends", user_b, False)
            elif u.id == user_b:
                self._mutate_or_buffer(ws, "_ws_friends", user_a, False)

    def _apply_block_added(self, blocker: int, blocked: int) -> None:
        """``blocker`` blocked ``blocked``. Update blocker's outgoing cache
        AND blocked's incoming cache + drop a friendship the route just
        tore down so the friends cache doesn't lie. The lifecycle events
        for friend_removed go out separately when applicable."""
        for ws, u in list(self._ws_user.items()):
            if u.id == blocker:
                self._mutate_or_buffer(ws, "_ws_blocks_out", blocked, True)
                self._mutate_or_buffer(ws, "_ws_friends", blocked, False)
            elif u.id == blocked:
                self._mutate_or_buffer(ws, "_ws_blocks_in", blocker, True)
                self._mutate_or_buffer(ws, "_ws_friends", blocker, False)

    def _apply_block_removed(self, blocker: int, blocked: int) -> None:
        for ws, u in list(self._ws_user.items()):
            if u.id == blocker:
                self._mutate_or_buffer(ws, "_ws_blocks_out", blocked, False)
            elif u.id == blocked:
                self._mutate_or_buffer(ws, "_ws_blocks_in", blocker, False)

    def _apply_friend_lifecycle(self, target_uid: int, payload: dict) -> None:
        """Live-update the friend/block caches from the lifecycle events that
        ``routes/friends.py`` + ``routes/blocks.py`` publish.

        The route publishes one envelope per affected side (e.g. both halves
        of an accept). We deduce the *other* user from the payload's ``data``
        field — the route puts ``user_id`` (the counterparty) into ``data``
        for every event that needs it.

        Recognised ops:
          friend_request_accepted → friendship installed; ``data.friendship.user_id``
                                    is the counterparty.
          friend_removed          → friendship gone; ``data.user_id``.
          user_blocked            → only the blocker receives this; updates
                                    blocker's outgoing + the blocked's
                                    incoming if that user is online.
          user_unblocked          → mirror of above.

        Friend-request created/declined/cancelled don't change the
        friend/block sets, only the pending list — handled by the
        client-side store, no cache mutation here.
        """
        op = payload.get("op")
        # Wire-Envelope ist {"op", "data"} (siehe publish_friend_event) — NICHT
        # "d". Mit "d" lieferte .get() immer None → die Cache-Branches feuerten
        # nie → Online-Freunde-/Block-Cache blieb bis zum Reconnect veraltet.
        d = payload.get("data") or {}
        if op == "friend_request_accepted":
            fship = d.get("friendship") or {}
            try:
                other = int(fship.get("user_id", "0"))
            except (TypeError, ValueError):
                other = 0
            if other:
                self._apply_friend_added(target_uid, other)
        elif op == "friend_removed":
            try:
                other = int(d.get("user_id", "0"))
            except (TypeError, ValueError):
                other = 0
            if other:
                self._apply_friend_removed(target_uid, other)
        elif op == "user_blocked":
            try:
                other = int(d.get("user_id", "0"))
            except (TypeError, ValueError):
                other = 0
            if other:
                # ``target_uid`` is the blocker (this event only goes to them)
                self._apply_block_added(blocker=target_uid, blocked=other)
        elif op == "user_unblocked":
            try:
                other = int(d.get("user_id", "0"))
            except (TypeError, ValueError):
                other = 0
            if other:
                self._apply_block_removed(blocker=target_uid, blocked=other)

    def _filter_presence_visibility(
        self, target_user_ids: set[int], sender_user_id: int
    ) -> set[int]:
        """Filter a presence-broadcast recipient set.

        Visibility rules (Etappe 2 + 3):
          * if the receiver has the sender in ``_ws_blocks_in`` (sender
            blocked the receiver) or ``_ws_blocks_out`` (receiver blocked
            the sender) → drop. Geblockte sehen den Blocker nicht.
          * otherwise → keep.

        Invisible masking is handled *before* this call: the guild:events
        envelope already carries the masked status (``invisible`` → ``"offline"``);
        this filter only governs *who* receives the event at all.

        Complexity: O(T + total sockets for target users) where T is the
        number of target user IDs.  Uses ``_user_conns`` as a reverse index
        to look up a user's sockets directly rather than scanning all
        ``_ws_user`` entries.
        """
        out: set[int] = set()
        for uid in target_user_ids:
            socks = self._user_conns.get(uid)
            if not socks:
                # User has no open sockets; no cached block info available —
                # include them (DB-based block checks happen elsewhere).
                out.add(uid)
                continue
            # Conservative gate for the register()→hydrate window: a socket
            # whose block caches are not yet hydrated (None) has an UNKNOWN
            # block status. Treating None as "not blocked" would let a
            # blocker's presence reach a freshly-connected receiver in that
            # window. Sync context here (no await), so a DB fallback isn't
            # clean — instead require *every* socket of the user to have a
            # hydrated cache that confirms "not blocked" before we include
            # the user. An un-hydrated socket → exclude (no presence leak).
            # Presence is re-synced on the ready frame anyway, so a brief
            # delay during hydration is acceptable; a leak is not.
            include = bool(socks)
            for ws in socks:
                bi = self._ws_blocks_in.get(ws)
                bo = self._ws_blocks_out.get(ws)
                if bi is None or bo is None:
                    # Block status unknown for this socket → don't risk a leak.
                    include = False
                    break
                if sender_user_id in bi or sender_user_id in bo:
                    include = False
                    break
            if include:
                out.add(uid)
        return out
