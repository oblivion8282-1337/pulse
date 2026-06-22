"""Per-socket friend / block caches used during pub/sub fan-out.

Extracted from :mod:`pubsub` as a mixin (Etappe 2 of the Voll-Discord friend
system). Holds the lazy-filled ``_ws_friends`` / ``_ws_blocks_out`` /
``_ws_blocks_in`` sets and the live-update logic that keeps them in sync
with the friend/block lifecycle events the REST routes publish.

State (``_ws_user``, ``_ws_friends``, ``_ws_blocks_out``, ``_ws_blocks_in``,
``_user_conns``, ``_lock``) is initialised in ``ConnectionManager.__init__``;
the mixin reaches it via ``self.`` through cooperative inheritance.
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
        warm. No-op for sockets that have been removed."""
        async with self._lock:
            if ws not in self._ws_user:
                return
            self._ws_friends[ws] = set(friends)
            self._ws_blocks_out[ws] = set(blocks_out)
            self._ws_blocks_in[ws] = set(blocks_in)

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

    def _apply_friend_added(self, user_a: int, user_b: int) -> None:
        """Mutate both users' cached friend sets when a friendship is installed."""
        for ws, u in list(self._ws_user.items()):
            if u.id == user_a:
                friends = self._ws_friends.get(ws)
                if friends is not None:
                    friends.add(user_b)
            elif u.id == user_b:
                friends = self._ws_friends.get(ws)
                if friends is not None:
                    friends.add(user_a)

    def _apply_friend_removed(self, user_a: int, user_b: int) -> None:
        for ws, u in list(self._ws_user.items()):
            if u.id == user_a:
                friends = self._ws_friends.get(ws)
                if friends is not None:
                    friends.discard(user_b)
            elif u.id == user_b:
                friends = self._ws_friends.get(ws)
                if friends is not None:
                    friends.discard(user_a)

    def _apply_block_added(self, blocker: int, blocked: int) -> None:
        """``blocker`` blocked ``blocked``. Update blocker's outgoing cache
        AND blocked's incoming cache + drop a friendship the route just
        tore down so the friends cache doesn't lie. The lifecycle events
        for friend_removed go out separately when applicable."""
        for ws, u in list(self._ws_user.items()):
            if u.id == blocker:
                bo = self._ws_blocks_out.get(ws)
                if bo is not None:
                    bo.add(blocked)
                friends = self._ws_friends.get(ws)
                if friends is not None:
                    friends.discard(blocked)
            elif u.id == blocked:
                bi = self._ws_blocks_in.get(ws)
                if bi is not None:
                    bi.add(blocker)
                friends = self._ws_friends.get(ws)
                if friends is not None:
                    friends.discard(blocker)

    def _apply_block_removed(self, blocker: int, blocked: int) -> None:
        for ws, u in list(self._ws_user.items()):
            if u.id == blocker:
                bo = self._ws_blocks_out.get(ws)
                if bo is not None:
                    bo.discard(blocked)
            elif u.id == blocked:
                bi = self._ws_blocks_in.get(ws)
                if bi is not None:
                    bi.discard(blocker)

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
