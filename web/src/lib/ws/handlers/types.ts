/**
 * Wire-type definitions for the chat-gateway WebSocket.
 *
 * Lives here (rather than in `connection.ts`) so the handler-map split can
 * import discriminants without pulling in the connection class. The union
 * stays exhaustive — every op the server emits has a variant. New events
 * extend `ServerEvent` and get a matching handler module under
 * `lib/ws/handlers/*`.
 */
import type { DMChannel, Message } from '$lib/api/types';
import type { Role as RolePayload, Overwrite as OverwritePayload } from '$lib/api/roles';
import type { UserVoiceState, VoiceChannelState } from '$lib/stores/voicePresence.svelte';
import type { StreamChannelState, StreamDescriptor } from '$lib/stores/streamPresence.svelte';
import type { StreamChatMessage } from '$lib/stores/streamChat.svelte';
import type { WatchChatMessage } from '$lib/stores/watchChat.svelte';
import type { WatchChannelEntry, WatchPartyState } from '$lib/stores/watchPartyPresence.svelte';
import type { FriendRequest } from '$lib/stores/friendRequests.svelte';
import type { CommunityInviteNotification } from '$lib/api/communityInvites';
import type { PrivacySettings } from '$lib/stores/privacy.svelte';
import type { PresenceStatus, OwnPresenceStatus } from '$lib/stores/presence.svelte';
import type { Device, DeviceMonitor, DeviceState } from '$lib/api/devices';

/** Art einer `remote_signal`-Nutzlast: SDP-Angebot, SDP-Antwort, ICE-Kandidat
 *  (`$lib/remote/p2p.ts`) — und die beiden Auskünfte, die vom Host zum
 *  Steuernden fließen: der Vorrang des Hosts (`$lib/remote/vorrang.ts`) und die
 *  Form seines Zeigers (`$lib/remote/zeigerform.ts`).
 *  An EINER Stelle, weil derselbe Satz Werte in beiden Richtungen der Leitung
 *  und in jedem Sender-Baustein auftaucht. **Mit der Prüfliste des Gateways
 *  synchron halten** (`ws_remote_handlers.py::handle_signal`). */
export type RemoteSignalKind = 'offer' | 'answer' | 'ice' | 'vorrang' | 'zeiger';

export type ChannelPayload = {
  id: string;
  guild_id: string;
  name: string;
  type: number;
  position: number;
  topic: string | null;
  created_at?: string;
};

export type GuildPayload = {
  id: string;
  name: string;
  icon_url: string | null;
  owner_id: string;
  /** Platform-frozen by the Cloud operator. Optional for back-compat frames. */
  suspended?: boolean;
  /** Per-community quality caps (null = inherit instance default). */
  voice_bitrate_max_kbps?: number | null;
  stream_bitrate_max_kbps?: number | null;
  stream_fps_max?: number | null;
  stream_resolution_max?: string | null;
};

export type ReactionEvent = {
  message_id: string;
  channel_id: string;
  user_id: string;
  emoji: string;
};

/** Per-guild slice of the ready frame. The role/permission fields were
 * added in Phase 3 (server-side); older payloads (e.g. mocked tests) may
 * still omit them. */
export type ReadyGuild = {
  id: string;
  name: string;
  icon_url?: string | null;
  created_at?: string;
  owner_id?: string;
  my_permissions?: string;
  my_role_ids?: string[];
  roles?: RolePayload[];
  sound_overrides?: { sound_id: string; url: string }[];
  /** Platform-frozen by the Cloud operator; the client renders it read-only. */
  suspended?: boolean;
  /** Per-community quality caps (null = inherit instance default). */
  voice_bitrate_max_kbps?: number | null;
  stream_bitrate_max_kbps?: number | null;
  stream_fps_max?: number | null;
  stream_resolution_max?: string | null;
};

export type ReadyEvent = {
  op: 'ready';
  user_id: string;
  /** Admin status on THIS server. Optional for back-compat with mocked frames. */
  is_admin?: boolean;
  /** Instanzweiter Anzeigename (vom Server-Admin gesetzt); null/absent = keiner. */
  instance_name?: string | null;
  guilds: ReadyGuild[];
  dm_channels?: DMChannel[];
  voice_states?: VoiceChannelState[];
  stream_states?: StreamChannelState[];
  watch_states?: WatchChannelEntry[];
  /** Server clock (unix ms) at ready-send time — seeds the watch-party clock
   * offset so position extrapolation uses the shared server clock. */
  server_now?: number;
  online_user_ids?: string[];
  voice_overrides?: {
    channel_id: string;
    user_id: string;
    muted: boolean;
    deafened: boolean;
  }[];
  // Etappe 4 friend-system payload — all optional so older mocked
  // ready frames in tests keep validating cleanly.
  friends?: { user_id: string; since: string }[];
  friend_requests_in?: FriendRequest[];
  community_invites?: CommunityInviteNotification[];
  friend_requests_out?: FriendRequest[];
  blocked_user_ids?: string[];
  privacy?: PrivacySettings;
  presence_status?: OwnPresenceStatus;
  user_presence_statuses?: Record<string, PresenceStatus>;
};

export type ServerEvent =
  | ReadyEvent
  | { op: 'message'; data: Message }
  | { op: 'message_update'; data: Message }
  | { op: 'message_delete'; data: { id: string; channel_id: string } }
  | { op: 'reaction_add'; data: ReactionEvent }
  | { op: 'reaction_remove'; data: ReactionEvent }
  | { op: 'message_ack'; nonce: string | null; id: string }
  | { op: 'channel_created'; channel: ChannelPayload }
  | { op: 'channel_updated'; channel: ChannelPayload }
  | { op: 'channel_deleted'; guild_id: string; channel_id: string }
  | { op: 'channel_revealed'; channel: ChannelPayload }
  | { op: 'channel_hidden'; guild_id: string; channel_id: string }
  | {
      op: 'channel_bump';
      guild_id: string;
      channel_id: string;
      message_id: string;
      author_id: string;
    }
  | {
      // DM activity envelope. Carries the (a, b) pair so each receiving
      // client decides locally whether it's a member; non-members ignore.
      op: 'dm_bump';
      channel_id: string;
      user_a_id: string;
      user_b_id: string;
      message_id: string;
      author_id: string;
    }
  | { op: 'guild_updated'; guild: GuildPayload }
  | { op: 'guild_deleted'; guild_id: string }
  | { op: 'guild_member_added'; guild_id: string; user_id: string }
  | { op: 'guild_member_removed'; guild_id: string; user_id: string }
  | {
      op: 'guild_ban_added';
      guild_id: string;
      user_id: string;
      reason?: string | null;
    }
  | { op: 'guild_ban_removed'; guild_id: string; user_id: string }
  | { op: 'complaint_new' }
  | {
      op: 'guild_membership_revoked';
      guild_id: string;
      guild_name: string;
      kind: 'ban' | 'kick';
      reason?: string | null;
    }
  | {
      op: 'guild_ban_lifted';
      guild_id: string;
      guild_name: string;
      invite_code: string;
    }
  | {
      op: 'guild_member_updated';
      guild_id: string;
      user_id: string;
      nickname: string | null;
    }
  | {
      op: 'voice_state';
      channel_id: string;
      user_ids: string[];
      streaming_user_ids?: string[];
      camera_user_ids?: string[];
      user_states?: Record<string, UserVoiceState>;
    }
  | {
      op: 'voice_override';
      channel_id: string;
      user_id: string;
      muted: boolean;
      deafened: boolean;
    }
  | {
      op: 'voice_disconnect';
      channel_id: string;
      user_id: string;
    }
  | {
      // A channel manager brought ``user_id`` into a voice channel (a
      // switch if they were connected elsewhere, a summon otherwise).
      // Cooperative: the target's own client connects.
      op: 'voice_pull';
      user_id: string;
      channel_id: string;
      channel_name: string;
      guild_id: string;
      pulled_by: string;
    }
  | {
      op: 'stream_state';
      channel_id: string;
      user_ids: string[];
      streams?: StreamDescriptor[];
    }
  | { op: 'presence_update'; user_id: string; online: boolean }
  | {
      op: 'stream_chat_message';
      channel_id: string;
      streamer_id: string;
      message: StreamChatMessage;
    }
  | {
      op: 'watch_state';
      channel_id: string;
      party_id: string;
      state: WatchPartyState | null;
      /** Server clock (unix ms) at push time — keeps the client's clock
       * offset calibrated for position extrapolation. */
      server_now?: number;
    }
  | { op: 'watch_watchers'; channel_id: string; party_id: string; user_ids: string[] }
  /** Ack to the host of a freshly-created party — carries the minted party_id
   * so the host's client can open its tile (the broadcast doesn't say "yours"). */
  | { op: 'watch_started'; channel_id: string; party_id: string }
  | { op: 'watch_chat_message'; channel_id: string; party_id: string; message: WatchChatMessage }
  | {
      op: 'watch_chat_reaction';
      data: {
        message_id: string;
        channel_id: string;
        party_id: string;
        user_id: string;
        emoji: string;
        added: boolean;
      };
    }
  | {
      op: 'permissions_updated';
      allow_guild_creation: boolean;
      allow_member_invites: boolean;
      // Self-Host-Anzeigename bei Umbenennung: "" = zurückgesetzt (Adresse
      // zeigen), undefined = Feld unverändert.
      instance_name?: string;
      guild_sound_max_size_bytes?: number;
      hq_bitrate_min_kbps?: number;
      hq_bitrate_max_kbps?: number;
      hq_fps_min?: number;
      hq_fps_max?: number;
      hq_resolution_max?: string;
      ns_bitrate_min_kbps?: number;
      ns_bitrate_max_kbps?: number;
      ns_fps_min?: number;
      ns_fps_max?: number;
      ns_resolution_max?: string;
      cam_resolution_max?: string;
      cam_fps_max?: number;
      voice_bitrate_max_kbps?: number;
    }
  | {
      op: 'guild_sound_updated';
      guild_id: string;
      sound_id: string;
      removed: boolean;
    }
  | {
      // Guild-Admin hat ein Plugin auf der Guild ein-/ausgeschaltet
      // (PUT /guilds/{id}/plugins/{name}) ODER der Bootstrap-Admin
      // hat das Plugin instanzweit deaktiviert (DELETE /admin/plugins/{name})
      // — letzteres pusht ein Event pro betroffener Guild mit enabled=false.
      // Receiver invalidiert seinen guild-activation-Cache.
      op: 'guild_plugins_changed';
      guild_id: string;
      plugin_name: string;
      enabled: boolean;
    }
  // Neue Moderations-Meldung in dieser Community. Nur an Moderator-Sockets
  // zugestellt (chat-gateway filtert auf Mod-Rechte). Trägt bewusst keine
  // PII (kein Melde-Text, keine Melder/Ziel-IDs) — nur reason_code für den
  // Toast + guild_id fürs Badge.
  | { op: 'report_new'; guild_id: string; report_id: string; reason_code: string }
  | { op: 'role_created'; role: RolePayload }
  | { op: 'role_updated'; role: RolePayload }
  | { op: 'role_deleted'; guild_id: string; role_id: string }
  | { op: 'member_roles_updated'; guild_id: string; user_id: string }
  | {
      op: 'channel_permissions_updated';
      guild_id: string;
      channel_id: string;
      overwrites: OverwritePayload[];
      restricted: boolean;
    }
  | {
      // Per-user mention notification — fanned out only to sockets owned
      // by mentioned users, so we can bump the channel's mention counter
      // even if the user isn't currently viewing or subscribed to it.
      op: 'mention_added';
      // `guild_id` is null for DMs (the channel isn't part of a guild). The
      // backend stringifies guild_id when present (Snowflake-as-string across
      // the wire — see CLAUDE.md) and emits null for the DM case.
      data: { channel_id: string; message_id: string; guild_id: string | null };
    }
  // ---- Etappe 4 friend system ------------------------------------------
  | { op: 'friend_request_received'; data: FriendRequest }
  | { op: 'community_invite_received'; data: CommunityInviteNotification }
  | {
      op: 'friend_request_accepted';
      data: {
        request_id: string;
        // ``status`` is the new friend's masked presence (invisible→offline),
        // included by the server so the Online tab shows them without a reload.
        friendship: {
          user_id: string;
          since: string;
          status?: 'online' | 'idle' | 'dnd' | 'offline';
        };
      };
    }
  | { op: 'friend_request_declined'; data: { request_id: string } }
  | { op: 'friend_request_cancelled'; data: { request_id: string } }
  | { op: 'friend_removed'; data: { user_id: string } }
  // Nur an Admin-Sockets zugestellt (chat-gateway filtert auf `is_admin`).
  // Trägt bewusst keine Antragsdaten — der Client lädt die Liste danach über
  // seinen Admin-Endpoint nach.
  | { op: 'admin_application_pending'; kind: 'app_host' | 'instance' }
  // An den Antragsteller (user:events). Toast + roter Punkt kommen aus den
  // Stores, die nach diesem Signal ihre Liste nachladen.
  | {
      op: 'application_decided';
      data: {
        kind: 'app_host' | 'instance';
        status: 'approved' | 'rejected';
        rejection_reason: string | null;
      };
    }
  | { op: 'user_blocked'; data: { user_id: string } }
  | { op: 'user_unblocked'; data: { user_id: string } }
  | {
      op: 'presence_status_changed';
      data: { user_id: string; status: PresenceStatus | 'invisible' };
    }
  // Ephemeral "user is typing" signal for a text channel / DM. No persistence;
  // the client tracks a short TTL per (channel, user) and shows "… schreibt".
  | { op: 'typing'; channel_id: string; user_id: string }
  // Fernsteuerung (remote control) — Consent-Handshake über den Serverweg.
  | {
      op: 'remote_request';
      session_id: string;
      channel_id: string;
      from_user_id: string;
      /** Welches Standplatz-Geraet gemeint ist, falls die Anfrage an einer
       *  Geraete-Kachel gestellt wurde. Wer nicht dieses Geraet ist, lehnt
       *  still ab (`$lib/remote/geraeteanbindung.ts`). */
      device_id?: string;
      /** Deckt eine Dauerfreigabe (`device_grants`) diese Anfrage? Nur
       *  gesetzt, wenn überhaupt ein Geraet gemeint ist — eine Anfrage an
       *  einen Menschen traegt das Feld gar nicht. Vom Gateway aufgeloest
       *  (Rollen, Kanalmitgliedschaft); der Client prueft nur noch seinen
       *  Hauptschalter (`$lib/remote/standplatz.svelte.ts`). */
      freigabe?: boolean;
    }
  // Nur an den STEUERNDEN, unmittelbar nach dem Anlegen der Sitzung und noch
  // bevor die Host-Tabs die Anfrage sehen. Erst damit kennt der Steuernde seine
  // `session_id` — vorher konnte er weder serverseitig abbrechen noch eine
  // hereinkommende Antwort der eigenen Sitzung zuordnen (jede fremde galt als
  // die eigene, s. `remote/session.svelte.ts::_pending`).
  | { op: 'remote_pending'; session_id: string; channel_id: string; host_user_id: string }
  | { op: 'remote_response'; session_id: string; accepted: boolean }
  | { op: 'remote_ended'; session_id: string; reason: string }
  // Antwort auf `remote_reclaim` (Gnadenfrist nach Verbindungsabriss,
  // `$lib/remote/wachten.ts`). `remote_reclaim_failed` trägt einen Klartext
  // nur fürs Log — angezeigt wird nichts, der lokale Zeitgeber der Gnadenfrist
  // beendet die Sitzung ohnehin gleich.
  | { op: 'remote_reclaimed'; session_id: string }
  | { op: 'remote_reclaim_failed'; session_id: string; reason: string }
  // Eingabe-Frames des Steuernden, vom Gateway unverändert durchgereicht (nur
  // der Host bekommt sie). Format: `docs/plans/2026-08-12-input-wire-protokoll-v2.md`.
  | { op: 'remote_input'; session_id: string; slot: number; frames: string[] }
  // SDP/ICE des P2P-Eingabewegs, peer-gebunden weitergereicht — das Gegenüber
  // der aktiven Sitzung verhandelt darüber den DataChannel (`$lib/remote/p2p.ts`).
  | { op: 'remote_signal'; session_id: string; kind: RemoteSignalKind; data: unknown }
  // Eine andere Host-Tab hat die Anfrage beantwortet → diese Tab schließt ihren
  // offenen Consent-Dialog.
  | { op: 'remote_canceled'; session_id: string }
  // Standplatz-Geraete (`$lib/devices/`). Beide sind im Gateway schon nach dem
  // Standplatz gefiltert: wer den Kanal nicht sehen darf, bekommt sie nicht.
  // `device_changed` traegt die ganze Zeile (auch beim Entfernen — die Kennung
  // wird zum Austragen gebraucht), `device_state` nur den Zustand.
  | {
      op: 'device_changed';
      guild_id: string;
      channel_id: string;
      device: Device;
      removed?: boolean;
      // Ist diese Abmeldung Teil eines Umstellens (Kanal-/Community-Wechsel),
      // nicht ein echtes Loeschen? Nur gueltig zusammen mit `removed: true`
      // (Pruefbefund K-1, 2026-08-20) — s. `nachzugAktion.ts`.
      moved?: boolean;
    }
  // Der Weckruf an das Geraet selbst: „fang bitte an zu uebertragen".
  | {
      op: 'device_wake';
      device_id: string;
      channel_id: string;
      from_user_id: string;
      monitor?: number;
    }
  | {
      op: 'device_state';
      guild_id: string;
      channel_id: string;
      device_id: string;
      state: DeviceState;
      busy_with?: string | null;
      monitors?: DeviceMonitor[];
      /** Plaetze, auf denen dieses Geraet gerade sendet. Fehlt bei aelteren
       *  Gegenstellen; leere Liste heisst „sendet nicht mehr". */
      stream_slots?: number[];
    }
  | { op: 'error'; code: number; msg: string };

export type ClientEvent =
  | { op: 'subscribe'; channel_id: string }
  | { op: 'unsubscribe'; channel_id: string }
  // Cloud-signiertes Profile-Statement → der Server cached den Anzeige-Namen
  // (CachedUserProfile). Ohne das zeigen Self-Hosts nur die rohe user-<id> (F19).
  | { op: 'profile_statement'; jwt: string }
  | { op: 'send'; channel_id: string; content: string; nonce: string; reply_to_id?: string | null }
  | {
      op: 'voice_self_state';
      channel_id: string | null;
      mic_muted: boolean;
      deafened: boolean;
    }
  | { op: 'watch_start'; channel_id: string; source_url: string }
  | { op: 'watch_stop'; channel_id: string; party_id: string }
  | {
      op: 'watch_control';
      channel_id: string;
      party_id: string;
      action: 'play' | 'pause' | 'seek';
      position: number;
      /** Source epoch the position was measured against — the server drops the
       *  op if the clip has since been swapped (advance/source_change). */
      source_epoch?: number;
    }
  | {
      op: 'watch_heartbeat';
      channel_id: string;
      party_id: string;
      position: number;
      source_epoch?: number;
    }
  | { op: 'watch_source_change'; channel_id: string; party_id: string; source_url: string }
  | { op: 'watch_join'; channel_id: string; party_id: string }
  | { op: 'watch_leave'; channel_id: string; party_id: string }
  | { op: 'watch_handoff'; channel_id: string; party_id: string; target_user_id?: string }
  | { op: 'watch_queue_add'; channel_id: string; party_id: string; source_url: string }
  | { op: 'watch_queue_remove'; channel_id: string; party_id: string; item_id: string }
  | {
      op: 'watch_queue_move';
      channel_id: string;
      party_id: string;
      item_id: string;
      index: number;
    }
  | { op: 'watch_queue_advance'; channel_id: string; party_id: string; item_id?: string }
  | { op: 'activity' }
  | { op: 'typing'; channel_id: string }
  // Fernsteuerung — Outbound-Ops des Consent-Handshakes (s. ws_remote_handlers.py).
  | { op: 'remote_request'; channel_id: string; host_user_id: string; device_id?: string }
  | { op: 'remote_respond'; session_id: string; accept: boolean }
  // Eingabe-Frames zum Host. Nur der Steuernde sendet; der Gateway prüft
  // Sitzung, Rolle und Größe und schaut nicht in die Frames hinein.
  | { op: 'remote_input'; session_id: string; slot: number; frames: string[] }
  | { op: 'remote_signal'; session_id: string; kind: RemoteSignalKind; data: unknown }
  | { op: 'remote_end'; session_id: string }
  // Nach einem Verbindungsabriss zurück, innerhalb der Gnadenfrist
  // (`$lib/remote/wachten.ts`, `ws_remote_reconnect.py::handle_reclaim`).
  | { op: 'remote_reclaim'; session_id: string }
  // „Dieser Rechner ist das Standplatz-Geraet X" — und die Ruecknahme. Der
  // Server sieht Verbindungen von Nutzern, nicht von Rechnern; nur der Rechner
  // selbst kennt seine Kennung (`$lib/devices/anmeldung.svelte.ts`).
  | {
      op: 'device_announce';
      device_id: string;
      monitors: { index: number; name: string; primary: boolean }[];
    }
  | { op: 'device_wake'; device_id: string; monitor?: number }
  // „Ich sende gerade auf diesen Plaetzen." Der Server kann es nicht ableiten:
  // der Strom laeuft unter dem Konto des Besitzers und traegt keine
  // Geraete-Kennung (`$lib/devices/darstellung.ts`).
  | { op: 'device_streams'; device_id: string; slots: number[] }
  | { op: 'device_withdraw'; device_id: string }
  // Fordert einen frischen ready-Frame an (server-autoritativer Snapshot).
  // Beim Server-Switch ZU einer schon offenen Connection ist der gecachte
  // ready stale (Live-voice/stream/watch-Events seit Connect fehlen darin) —
  // resync holt den aktuellen Stand, statt den stale Cache zu replayen.
  | { op: 'resync' }
  | { op: 'ping' };

/** Narrow `ServerEvent` to the variant that has the given `op`. Used by
 *  individual handler modules so they keep static-typing on `evt`. */
export type EventOf<Op extends ServerEvent['op']> = Extract<ServerEvent, { op: Op }>;
