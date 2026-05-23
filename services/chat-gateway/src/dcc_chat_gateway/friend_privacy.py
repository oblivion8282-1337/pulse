"""Constants for the Voll-Discord-Freundschaftssystem policies.

Numeric values are stored as ``SMALLINT`` in ``user_privacy``. Keeping
them as plain ints (vs. a DB enum) means a new policy needs only a
constant here + route-side handling, no migration.

* ``DM_POLICY_*`` controls who can open a DM with this user:
    - 0 EVERYONE       — anyone with the user id can DM (current default
                          behaviour, pre-privacy-feature)
    - 1 SERVER_MEMBERS — must share at least one guild
    - 2 FRIENDS_ONLY   — must be on the friends list
    - 3 NOBODY         — DMs from non-friends rejected even after a
                          shared guild; friends ALWAYS bypass
* ``FRIEND_REQ_POLICY_*`` mirrors the same ladder for incoming
   friend-requests (no FRIENDS_ONLY entry — by definition someone
   sending a friend-request is *not yet* a friend, so the option would
   be a permanent-no, which is what NOBODY already means).
"""

from __future__ import annotations

# DM policies
DM_POLICY_EVERYONE = 0
DM_POLICY_SERVER_MEMBERS = 1
DM_POLICY_FRIENDS_ONLY = 2
DM_POLICY_NOBODY = 3

DM_POLICY_VALUES = frozenset(
    {
        DM_POLICY_EVERYONE,
        DM_POLICY_SERVER_MEMBERS,
        DM_POLICY_FRIENDS_ONLY,
        DM_POLICY_NOBODY,
    }
)

# Friend-request policies
FRIEND_REQ_POLICY_EVERYONE = 0
FRIEND_REQ_POLICY_SERVER_MEMBERS = 1
FRIEND_REQ_POLICY_NOBODY = 2

FRIEND_REQ_POLICY_VALUES = frozenset(
    {
        FRIEND_REQ_POLICY_EVERYONE,
        FRIEND_REQ_POLICY_SERVER_MEMBERS,
        FRIEND_REQ_POLICY_NOBODY,
    }
)

# Defaults used by the "no privacy row yet" branch in routes/privacy.py.
DEFAULT_DM_POLICY = DM_POLICY_EVERYONE
DEFAULT_FRIEND_REQ_POLICY = FRIEND_REQ_POLICY_EVERYONE
DEFAULT_SHOW_IN_SEARCH = True
