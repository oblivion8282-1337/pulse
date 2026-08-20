"""Guild-lifecycle events.

Published on the ``guild:events`` Redis channel and forwarded to every
connected WebSocket (filtered by guild-membership inside the listener).

All snowflake-ish identifiers are strings on the wire. The nested
``channel`` / ``guild`` / ``role`` sub-shapes are intentionally typed as
free-form dicts here — their full shapes live in chat-gateway schemas
(``ChannelOut``, ``GuildOut``, ``RoleOut``); duplicating them into shared
would invert the dependency direction (shared can't know about
SQLAlchemy models).
"""

from __future__ import annotations

from typing import Any, Literal

from dcc_shared.events._base import _EventBase

# ---- Channels --------------------------------------------------------------


class ChannelCreatedEvent(_EventBase):
    op: Literal["channel_created"] = "channel_created"
    channel: dict[str, Any]


class ChannelUpdatedEvent(_EventBase):
    op: Literal["channel_updated"] = "channel_updated"
    channel: dict[str, Any]


class ChannelDeletedEvent(_EventBase):
    op: Literal["channel_deleted"] = "channel_deleted"
    guild_id: str
    channel_id: str


class ChannelRevealedEvent(_EventBase):
    """A previously-hidden channel became visible to this one user
    (voice-pull grant). Delivered direct-to-user via ``user:events``;
    carries the full channel dict so the client can insert it into its
    channel list without a refetch. The ``channel: dict`` shape mirrors
    ``ChannelCreatedEvent`` on purpose — same handler logic applies."""

    op: Literal["channel_revealed"] = "channel_revealed"
    channel: dict[str, Any]


class ChannelHiddenEvent(_EventBase):
    """Counterpart to ``ChannelRevealedEvent``: a voice-pull grant was
    revoked (the user left the channel) and the channel must leave this
    user's channel list. Direct-to-user via ``user:events``; mirrors the
    ``ChannelDeletedEvent`` shape."""

    op: Literal["channel_hidden"] = "channel_hidden"
    guild_id: str
    channel_id: str


class ChannelPermissionsUpdatedEvent(_EventBase):
    op: Literal["channel_permissions_updated"] = "channel_permissions_updated"
    channel_id: str
    guild_id: str
    overwrites: list[dict[str, Any]]
    # True when the channel's @everyone overwrite now denies VIEW_CHANNEL —
    # lets clients flip the lock indicator without knowing the @everyone
    # role id themselves.
    restricted: bool = False


# ---- Guild metadata + lifecycle --------------------------------------------


class GuildUpdatedEvent(_EventBase):
    op: Literal["guild_updated"] = "guild_updated"
    guild: dict[str, Any]


class GuildDeletedEvent(_EventBase):
    op: Literal["guild_deleted"] = "guild_deleted"
    guild_id: str


# ---- Members ---------------------------------------------------------------


class GuildMemberAddedEvent(_EventBase):
    op: Literal["guild_member_added"] = "guild_member_added"
    guild_id: str
    user_id: str


class GuildMemberUpdatedEvent(_EventBase):
    op: Literal["guild_member_updated"] = "guild_member_updated"
    guild_id: str
    user_id: str
    nickname: str | None = None


class GuildMemberRemovedEvent(_EventBase):
    op: Literal["guild_member_removed"] = "guild_member_removed"
    guild_id: str
    user_id: str


# ---- Bans ------------------------------------------------------------------


class GuildBanAddedEvent(_EventBase):
    op: Literal["guild_ban_added"] = "guild_ban_added"
    guild_id: str
    user_id: str
    # Reason is optional on the wire (publisher only sets it when non-null).
    reason: str | None = None


class GuildBanRemovedEvent(_EventBase):
    op: Literal["guild_ban_removed"] = "guild_ban_removed"
    guild_id: str
    user_id: str


# ---- Moderation ------------------------------------------------------------


class ReportNewEvent(_EventBase):
    """A new moderation report was filed in this guild — delivered only to
    the guild's moderators (listener narrows to mod-perm holders).

    Deliberately carries NO PII: no report body, no reporter/target ids.
    ``reason_code`` is a fixed enum (spam | harassment | illegal | csam |
    other) so the client can label the toast without a fetch; ``guild_id``
    routes the open-reports badge; ``report_id`` lets the client dedupe."""

    op: Literal["report_new"] = "report_new"
    guild_id: str
    report_id: str
    reason_code: str


class ComplaintNewEvent(_EventBase):
    """A new operator complaint (abuse report) arrived — delivered direct to
    platform admins (via ``user:events``) so their inbox badge + open list
    update live, without a reload. Carries NO PII (just the op) — the client
    re-fetches the count/list itself."""

    op: Literal["complaint_new"] = "complaint_new"


class GuildMembershipRevokedEvent(_EventBase):
    """Direct-to-user notice that THIS user was removed from a guild by a
    moderator — a ban or a kick. Delivered via ``user:events`` so it reaches
    the affected user even though they're no longer a member (guild-scoped
    fan-out would never find them).

    ``reason`` is only ever set for a ban and is PRIVATE to the recipient —
    it is never part of the guild-wide ``guild_ban_added`` broadcast."""

    op: Literal["guild_membership_revoked"] = "guild_membership_revoked"
    guild_id: str
    guild_name: str
    kind: Literal["ban", "kick"]
    reason: str | None = None


class GuildBanLiftedEvent(_EventBase):
    """Direct-to-user notice that a moderator lifted THIS user's ban. Carries a
    freshly-minted single-use rejoin invite so the client can offer a one-click
    "rejoin" — the unbanned user needn't hunt for a new invite."""

    op: Literal["guild_ban_lifted"] = "guild_ban_lifted"
    guild_id: str
    guild_name: str
    invite_code: str


# ---- Roles + role-member assignments ---------------------------------------


class RoleCreatedEvent(_EventBase):
    op: Literal["role_created"] = "role_created"
    role: dict[str, Any]


class RoleUpdatedEvent(_EventBase):
    op: Literal["role_updated"] = "role_updated"
    role: dict[str, Any]


class RoleDeletedEvent(_EventBase):
    op: Literal["role_deleted"] = "role_deleted"
    guild_id: str
    role_id: str


class MemberRolesUpdatedEvent(_EventBase):
    """Hint event (no payload body) — receiver re-fetches the affected
    member's role list. Keeps the publish path tiny + side-steps the
    "what role(s) changed" diff problem on the wire."""

    op: Literal["member_roles_updated"] = "member_roles_updated"
    guild_id: str
    user_id: str


# ---- Admin / settings ------------------------------------------------------


class PermissionsUpdatedEvent(_EventBase):
    """Pulse-admin-level toggles. Fired when ``chat_settings`` changes
    so clients can re-gate UI (create-guild / create-invite buttons,
    sound upload size). Bool fields can be omitted in publish (publisher
    only sets fields it actually changed) — defaults reflect "field
    absent" on the wire."""

    op: Literal["permissions_updated"] = "permissions_updated"
    allow_guild_creation: bool | None = None
    allow_member_invites: bool | None = None
    # Self-Host-Anzeigename. Damit eine Umbenennung sofort bei ALLEN
    # verbundenen Mitgliedern ankommt (nicht erst beim nächsten ``ready``).
    # ``""`` = zurückgesetzt (Adresse zeigen), ``None`` = Feld unverändert.
    instance_name: str | None = None
    guild_sound_max_size_bytes: int | None = None
    # Global HQ-stream limits (best-effort, client-enforced).
    hq_bitrate_min_kbps: int | None = None
    hq_bitrate_max_kbps: int | None = None
    hq_fps_min: int | None = None
    hq_fps_max: int | None = None
    hq_resolution_max: str | None = None
    # Global normal-stream (browser screen-share) limits — separate set.
    ns_bitrate_min_kbps: int | None = None
    ns_bitrate_max_kbps: int | None = None
    ns_fps_min: int | None = None
    ns_fps_max: int | None = None
    ns_resolution_max: str | None = None
    # Global webcam capture limits.
    cam_resolution_max: str | None = None
    cam_fps_max: int | None = None
    # Instanzweiter Voice-Bitrate-Deckel (kbps).
    voice_bitrate_max_kbps: int | None = None


class GuildSoundUpdatedEvent(_EventBase):
    op: Literal["guild_sound_updated"] = "guild_sound_updated"
    guild_id: str
    sound_id: str
    removed: bool


# ---- Plugin-System (Pro-Guild-Toggle) --------------------------------------


class GuildPluginsChangedEvent(_EventBase):
    """Guild-Admin hat ein Plugin auf der Guild ein-/ausgeschaltet.

    Wird vom PUT/DELETE-Pfad (``routes/guild_plugins.py`` +
    ``routes/admin_plugins.py``) publisht, damit alle Guild-Member ihren
    ``guild-activation``-Cache live invalidieren können — ohne F5.

    Op ist **nicht** colon-namespaced: das ist ein Core-Event über einen
    Plugin-Effekt, kein Plugin-eigener Op-Code. Der Listener-Validator
    behandelt es normal (kein ``:``-Bypass).
    """

    op: Literal["guild_plugins_changed"] = "guild_plugins_changed"
    guild_id: str
    plugin_name: str
    enabled: bool


# ---- Standplatz-Geraete -----------------------------------------------------
#
# Ein Geraet ist ein Rechner, der in einem Sprachkanal STEHT, ohne dort
# Teilnehmer zu sein (``docs/plans/2026-08-14-fernsteuerung-unbeaufsichtigte-
# geraete.md``). Beide Ereignisse tragen die Kanal-Kennung an oberster Stelle,
# weil beide danach gefiltert werden: sichtbar ist ein Geraet genau dem, der
# seinen Standplatz sehen darf (``VIEW_CHANNEL``) — dieselbe Schranke wie fuer
# den Kanal selbst.


class DeviceChangedEvent(_EventBase):
    """Ein Geraet wurde eingetragen, umbenannt, umgestellt oder entfernt.

    ``device`` traegt die volle Zeile (wie ``DeviceOut``), damit die Liste im
    Client ohne Nachladen stimmt. Beim Entfernen steht dort der LETZTE Stand —
    der Client braucht die Kennung zum Austragen, und der Name macht eine
    Meldung lesbar.
    """

    op: Literal["device_changed"] = "device_changed"
    guild_id: str
    channel_id: str
    device: dict
    removed: bool = False
    #: Ist diese Abmeldung Teil eines Umstellens (Kanal-/Community-Wechsel),
    #: nicht ein echtes Loeschen? Ohne dieses Feld ist die Abmeldung an den
    #: ALTEN Standplatz beim Umstellen vom Loeschen nicht unterscheidbar — der
    #: Client raeumte seine lokale Eintragung dauerhaft weg, obwohl das Geraet
    #: nur umgezogen ist (Pruefbefund K-1, 2026-08-20). Nur gueltig zusammen
    #: mit ``removed=True``.
    moved: bool = False


class DeviceStateEvent(_EventBase):
    """Der Zustand eines Geraets hat sich geaendert: bereit / belegt / offline.

    Getrennt von ``device_changed``, weil es aus einer ganz anderen Quelle
    kommt: nicht aus der Datenbank, sondern aus lebenden Verbindungen. Ein
    Geraet meldet sich beim Verbinden an und faellt beim Trennen heraus; eine
    Spalte dafuer wuerde nach jedem Absturz luegen.
    """

    op: Literal["device_state"] = "device_state"
    guild_id: str
    channel_id: str
    device_id: str
    #: ``ready`` | ``busy`` | ``offline``
    state: str
    #: Wer gerade steuert (nur bei ``busy``).
    busy_with: str | None = None
    #: Die gemeldeten Bildschirme. Reisen hier mit, weil sie ueber DENSELBEN
    #: Anlass hereinkommen wie der Zustand (die Anmeldung des Geraets) — ein
    #: eigenes Ereignis dafuer waere ein zweiter Rahmen fuer dieselbe Nachricht.
    monitors: list[dict] = []
    #: Die Plaetze, auf denen dieses Geraet gerade sendet.
    #:
    #: Reisen hier mit, obwohl sie einen eigenen Anlass haben (das Geraet
    #: startet oder beendet einen Strom): der Empfaenger fuehrt beides an
    #: derselben Stelle zusammen, und ein zweiter Rahmen fuer dieselbe Zeile
    #: haette nur zwei Wege geschaffen, auf denen dieselbe Anzeige veralten
    #: kann.
    #:
    #: **Wozu:** der Strom eines Geraets laeuft unter dem Konto seines
    #: Besitzers, im Streaming-Weg gibt es keine Geraete-Kennung. Ohne diese
    #: Liste muss die Oberflaeche raten, welcher Strom vom Rechner kommt und
    #: welcher vom Menschen davor — und sie hat falsch geraten (LIVE-Abzeichen
    #: am unbeteiligten Standplatz).
    stream_slots: list[int] = []


# ---- Dropbox / Ablage ------------------------------------------------------
#
# Mutationen an Datei-/Ordner-Einträgen. Die ``entry`` dicts sind freiform-
# shaped — die Wahrheit liegt in ``DropboxEntryOut`` (``routes/_dropbox_schemas.py``);
# shared/events kennt SQLAlchemy nicht. Events sind nach Art der Mutation
# getrennt (statt ein ``action: Literal[``...``]``-Sammelevent), weil jeder
# Konsument genau eine Variante verarbeitet — Saves-Round-Trips beim
# Listener-Validator und macht WS-Subscriptions per op lesbar.

class DropboxEntryCreatedEvent(_EventBase):
    """Neuer Eintrag (Datei ODER Ordner) angelegt — inklusive nach erfolgreichem
    Direct-Upload (PUT zu MinIO via Presigned-URL)."""

    op: Literal["dropbox_entry_created"] = "dropbox_entry_created"
    guild_id: str
    entry: dict[str, Any]


class DropboxEntryUpdatedEvent(_EventBase):
    """Eintrag verändert — rename, move (parent_path), pin/unpin, oder
    overwrite (neue Version einer Datei)."""

    op: Literal["dropbox_entry_updated"] = "dropbox_entry_updated"
    guild_id: str
    entry: dict[str, Any]


class DropboxEntryDeletedEvent(_EventBase):
    """Soft-Delete (Papierkorb) — die MinIO-Bytes sind noch da; Storage-Key
    steht weiter auf der DB-Row. Hard-Purge erfolgt später durch den Sweep."""

    op: Literal["dropbox_entry_deleted"] = "dropbox_entry_deleted"
    guild_id: str
    entry: dict[str, Any]


class DropboxEntryRestoredEvent(_EventBase):
    """Aus dem Papierkorb zurückgeholt — deleted_at wird NULL."""

    op: Literal["dropbox_entry_restored"] = "dropbox_entry_restored"
    guild_id: str
    entry: dict[str, Any]


class DropboxEntryPurgedEvent(_EventBase):
    """Hard-Delete durch den Trash-Sweep nach ``trash_retention_days`` —
    MinIO-Objekt ist weg, DB-Row weg. Clients droppen den Eintrag aus der
    Papierkorb-Ansicht ohne Rückfrage."""

    op: Literal["dropbox_entry_purged"] = "dropbox_entry_purged"
    guild_id: str
    # Die nackte ID reicht hier — der Eintrag verschwindet komplett. Client
    # braucht keinen vollen Eintrag, nur den Index zum Entfernen.
    entry_id: str
    kind: int  # 0 = folder, 1 = file


class DropboxQuotaUpdatedEvent(_EventBase):
    """Quota-Snapshot — bei Settings-Änderung (Admin) oder wenn
    ``used_bytes`` merklich wandert (Upload/Delete/Restore-Pfad). Client
    lädt die Sidebar-Anzeige ohne Roundtrip zur API."""

    op: Literal["dropbox_quota_updated"] = "dropbox_quota_updated"
    guild_id: str
    enabled: bool
    total_quota_bytes: int
    per_file_max_bytes: int
    used_bytes: int
    trash_retention_days: int
