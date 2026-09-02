/**
 * `ready` handler — seeds the Svelte stores from the initial frame and
 * triggers the gateway's buffer-flush via the context callback.
 *
 * Kept as a regular handler (not special-cased in the connection) so a
 * plugin can layer extra seeding on top (Phase 4): register a *second*
 * "ready" handler that runs after this one. The downside of `Map.set`
 * overwriting on duplicate keys is a non-issue because the connection
 * itself only calls `register` once during bootstrap.
 */
import { guilds } from '$lib/stores/guilds.svelte';
import { directMessages } from '$lib/stores/directMessages.svelte';
import { voicePresence } from '$lib/stores/voicePresence.svelte';
import { streamPresence } from '$lib/stores/streamPresence.svelte';
import { watchPartyPresence } from '$lib/stores/watchPartyPresence.svelte';
import { clockSync } from '$lib/watch/clockSync';
import { presence } from '$lib/stores/presence.svelte';
import { friends } from '$lib/stores/friends.svelte';
import { friendRequests } from '$lib/stores/friendRequests.svelte';
import { communityInvites } from '$lib/stores/communityInvites.svelte';
import { blocks } from '$lib/stores/blocks.svelte';
import { privacy } from '$lib/stores/privacy.svelte';
import { roles } from '$lib/stores/roles.svelte';
import { Perm } from '$lib/permissions/bitfield';
import { modQueueCounts } from '$lib/stores/modQueueCounts.svelte';
import { guildSounds } from '$lib/stores/guildSounds.svelte';
import { serverAdmin } from '$lib/stores/serverAdmin.svelte';
import { serversStore } from '$lib/api/servers.svelte';
import { activeServer } from '$lib/stores/active-server.svelte';
import { registerWsHandler } from '../handler-registry';
import type { ReadyStamps } from '../gateway-connection';
import type { ReadyEvent } from './types';
import type { Guild } from '$lib/api/types';
import { cloudGateway, gatewayForServer } from '$lib/ws/connection';
import { geraeteAnmeldung } from '$lib/devices/anmeldung.svelte';
import { darfStandplatzSein } from '$lib/remote/darfStandplatzSein';
import { gesundheitTor } from '$lib/stream/gesundheitTor';
import { standplatz } from '$lib/remote/standplatz.svelte';
import { postfachAbholenUndAnzeigen } from './chat';
import { gruppenApi } from '$lib/api/gruppen';
import { privateGruppen } from '$lib/stores/privateGruppen.svelte';

/** Extra context fields that only the ready handler cares about — kept
 *  separate from `HandlerContext` so other handlers don't see them. */
export type ReadyContext = {
  /** Called once the store seeding is done. The gateway uses it to
   *  resolve `waitForReady()` and replay any buffered events. */
  onReadySeeded: () => void;
  /** Live-Blick auf die abonnierten Kanaele der dispatchenden Verbindung
   *  (dieselbe Quelle wie `HandlerContext.subs`, s. `gateway-handlers-
   *  bootstrap.ts`). `ready` bekommt normalerweise keinen `HandlerContext`
   *  gereicht — dieser eine Aufruf braucht ihn trotzdem fuer den
   *  Postfach-Nachholvorgang, deshalb wird er hier separat durchgereicht,
   *  statt `ReadyContext` insgesamt um `subs` zu erweitern. */
  getSubs: () => Set<string>;
};

export function register(ctx: ReadyContext): void {
  registerWsHandler('ready', (evt) => {
    // Global-Friends Stufe 1 — der ready-Frame ist gesplittet:
    //  - SERVER-Teil (guilds/roles/sounds/voice/stream/watch/guild-presence/
    //    clock) gilt nur, wenn DIESE Connection die **aktive** ist.
    //  - SOCIAL-Teil (friends/dm_channels/friend_requests/blocks/eigener
    //    Presence-Status) gilt nur, wenn DIESE Connection die **Cloud** ist.
    // Cloud==aktiv → beide Teile (heutiges Verhalten unverändert). Self-Host
    // aktiv → Server-Teil vom Self-Host-ready + Social-Teil vom Cloud-
    // Background-ready. Die Flags stempelt `gateway-connection._handle`
    // synchron vor dem Dispatch auf das (lokale, nie über die Leitung
    // gesendete) ready-Event.
    const stamped = evt as ReadyEvent & ReadyStamps;
    // Default true (back-compat): ältere/gemockte Frames ohne Stempel werden
    // wie früher behandelt — beides anwenden (entspricht Cloud==aktiv).
    const isActive = stamped._isActive ?? true;
    const isCloud = stamped._isCloud ?? true;

    if (isActive) {
      // ---- SERVER-Teil (aktiv-only) ------------------------------------
      // The Ready frame is the single source of truth for the guild list —
      // `+layout.svelte` no longer fires a parallel `GET /guilds`. We upsert
      // each guild (so a reconnect picks up renames/icon-changes that
      // happened while we were offline) and reap stale entries that are no
      // longer in the user's set. Lifecycle events that arrived before Ready
      // are still replayed from the pre-ready buffer.
      const seen = new Set<string>();
      for (const g of evt.guilds) {
        seen.add(g.id);
        const existing = guilds.byId[g.id];
        guilds.byId[g.id] = {
          ...(existing ?? {}),
          ...g,
          icon_url: g.icon_url ?? existing?.icon_url ?? null,
          created_at: g.created_at ?? existing?.created_at ?? '',
          owner_id: g.owner_id ?? existing?.owner_id ?? ''
        } as Guild;
      }
      for (const gid of Object.keys(guilds.byId)) {
        if (!seen.has(gid)) guilds.remove(gid);
      }
      guilds.loaded = true;
      // The role payload is part of the ready envelope, not REST, so it's
      // populated here (the hydrate() pass on the REST side does not return
      // roles — they only come from /guilds/{id}/roles or this frame).
      roles.seedFromReady(evt.guilds);
      guildSounds.seedFromReady(evt.guilds);
      // Offene-Meldungen-Badge: für jede Community, in der wir moderieren, den
      // Zähler laden. MUSS nach roles.seedFromReady laufen (hasGuildPermission
      // braucht die frisch geseedeten Rollen). Nicht-Mod-Guilds werden nicht
      // abgefragt (der Count-Endpoint würde 403en).
      const modGuildIds = evt.guilds
        .filter(
          (g) =>
            roles.hasGuildPermission(g.id, Perm.MANAGE_MESSAGES) ||
            roles.hasGuildPermission(g.id, Perm.BAN_MEMBERS) ||
            roles.hasGuildPermission(g.id, Perm.MANAGE_GUILD)
        )
        .map((g) => g.id);
      void modQueueCounts.hydrate(modGuildIds);
      if (evt.voice_states) voicePresence.seed(evt.voice_states);
      voicePresence.seedOverrides(evt.voice_overrides ?? []);
      streamPresence.seed(evt.stream_states ?? []);
      watchPartyPresence.seed(evt.watch_states ?? []);
      // Calibrate the watch-party clock offset on connect so position
      // extrapolation uses the server clock from the first frame on.
      if (typeof evt.server_now === 'number') clockSync.record(evt.server_now);
      // Guild-Presence (wer ist auf DIESEM Server online) bleibt server-lokal.
      presence.seed(evt.online_user_ids ?? []);
    }

    if (isCloud) {
      // ---- SOCIAL-Teil (Cloud-only) ------------------------------------
      // Globale Freunde/DMs/Requests/Blocks kommen ausschließlich aus dem
      // Cloud-ready. All fields optional for back-compat with older mocked
      // ready frames; we fall through to clean defaults when absent.
      if (evt.dm_channels) directMessages.seed(evt.dm_channels);
      friends.seedAll(evt.friends ?? []);
      friendRequests.seedAll({
        incoming: evt.friend_requests_in ?? [],
        outgoing: evt.friend_requests_out ?? []
      });
      communityInvites.seedAll(evt.community_invites ?? []);
      blocks.seedAll(evt.blocked_user_ids ?? []);
      if (evt.privacy) privacy.seed(evt.privacy);
      // Own presence status + the friend-presence status map come from the
      // Cloud. Seeded on every reconnect so stale entries from a previous
      // session are cleared; absent fields reset to the 'online'/offline
      // defaults.
      presence.seedStatuses(
        evt.user_presence_statuses ?? {},
        evt.presence_status ?? 'online'
      );
      // Cloud-global: den Freundes-Präsenz-Topf setzen. Getrennt vom
      // aktiven-Server-Set (Zeile ~97, isActive) — ein Self-Host-ready darf die
      // Freundes-Präsenz nicht überschreiben. Nur die Cloud befüllt ihn.
      presence.seedFriends(evt.online_user_ids ?? []);
      presence.seedFriendStatuses(evt.user_presence_statuses ?? {});
      // Verpasste verschluesselte DMs nachholen (Bughunt-Runde 3, FIX 1) —
      // DMs sind cloud-only (s. `krypto/empfangen.ts`), deshalb hier im
      // Cloud-Zweig, nicht im Server-Zweig oben. Bis hierhin war
      // `postfach_neu` (`ws/handlers/chat.ts`) der EINZIGE Ausloeser fuer
      // `postfachAbholenUndEntschluesseln` — schloss die Verbindung, bevor der
      // Weckruf ankam (Tab zu, Redis-Publish verloren, WS-Abriss), holte NIE
      // wieder jemand die liegen gebliebene Zustellung ab. `ready` feuert bei
      // JEDEM Connect/Reconnect und ist damit der natuerliche Nachhol-Punkt.
      // `postfachAbholenUndAnzeigen` (`./chat.ts`) traegt bereits das
      // Einzeltakt-Gate (`mitNachlaufBeiWeckung` in `empfangen.ts`/
      // `postfachNachlauf.ts`) — ein gleichzeitiger `postfach_neu`-Weckruf
      // haengt sich an denselben (oder einen vorgemerkten Nachlauf-)Zyklus
      // an, statt ihn doppelt zu fahren. `ctx.getSubs()` liefert denselben
      // Live-Blick wie `HandlerContext.subs` (dieselbe Quelle,
      // `gateway-handlers-bootstrap.ts`) — beim Verarbeiten des `ready`-
      // Rahmens steht `_dispatchingConn` schon synchron auf dieser
      // Verbindung (`gateway-connection.ts::_handle`), und `subs` ueberlebt
      // einen Reconnect (nur `disconnect()` leert es) und wird dabei sogar
      // aktiv neu abonniert (Zeilen ~429f.) — die Menge ist also zum
      // Zeitpunkt dieses Aufrufs bereits die richtige.
      // Private Gruppen (Etappe G2) kennt der `ready`-Rahmen nicht — der
      // Server fuehrt kein Gruppenfeld darin (`routes/ws_ready.py`), und es
      // gibt auch kein Ereignis ueber einen Mitgliederwechsel. `GET /gruppen`
      // ist der einzige Weg an den Bestand, und er muss hier laufen, BEVOR
      // eine Gruppen-Zustellung ankommt: `verlaufSpeichernPflicht` legt eine
      // Nachricht nur in einem lokal BEKANNTEN Kanal ab und wirft sonst — die
      // Zustellung bliebe unquittiert liegen (kein Verlust, aber ein Zyklus
      // Verzoegerung). Bei ausgeschaltetem Schalter geht kein Aufruf hinaus
      // (`api/gruppen.ts`), die Antwort ist dann eine leere Liste.
      void gruppenApi
        .auflisten()
        .then((gruppen) => {
          privateGruppen.seed(gruppen);
          // **Jede Gruppe wird abonniert, nicht erst die geoeffnete.** Der
          // `postfach_neu`-Weckruf faechert am Server an die Abonnenten des
          // Kanals auf (`pubsub_channel_handlers.py::handle_chat_channel`) —
          // ohne Abonnement erfaehrt der Klient von einer Gruppennachricht
          // erst beim naechsten `ready`, also nach einem Neuladen. Bei DMs
          // reicht das Abonnieren beim Oeffnen, weil dort zusaetzlich der
          // `dm_bump` ueber den Nutzer-Kanal laeuft; fuer Gruppen gibt es
          // kein solches Ereignis.
          for (const gruppe of gruppen) cloudGateway.subscribe(gruppe.id);
        })
        // Ein Fehlschlag darf den `ready`-Rahmen nicht kippen: ohne
        // Gruppenliste laeuft alles andere unveraendert weiter.
        .catch(() => undefined);
      postfachAbholenUndAnzeigen((kanalId) => ctx.getSubs().has(kanalId));
    }

    // Der Admin-Status haengt am DISPATCHENDEN Server (aktiv ODER
    // Cloud-Hintergrund) und wird deshalb fuer beide ready-Varianten gesetzt.
    //
    // Die zweite Kennung, die hier bis zum 2026-08-28 mitgepflegt wurde, gibt es
    // nicht mehr: Ein Self-Host fuehrt seit dem Ticket-Weg dieselbe Nutzer-
    // Kennung wie die Cloud.
    const sid = stamped._serverId ?? activeServer.current?.id;
    if (sid) {
      serverAdmin.set(sid, evt.is_admin ?? false);
      // Instanzweiter Anzeigename vom Server-Admin → als Default-Name dieses
      // Servers cachen (greift nur, wenn der User keinen eigenen vergeben hat;
      // s. serverDisplayName). null überschreibt einen stale Namen bewusst.
      serversStore.update(sid, { server_name: evt.instance_name ?? null });
    }
    // **Tote Eintragungen raeumen, BEVOR sich der Rechner meldet.** Die
    // Communityliste dieses Rahmens ist die alleinige Wahrheit darueber, in
    // welchen Communitys der Nutzer auf diesem Server steckt (s. oben, der
    // Server-Teil wirft danach auch verschwundene Communitys aus dem Store).
    // Steht die Community einer lokalen Eintragung nicht darin, kann diese
    // Eintragung nichts mehr bedeuten: `device_announce` verwirft sie still,
    // und die `device_changed`-Meldung, die sie sonst raeumen wuerde, erreicht
    // uns nie mehr (Bughunt 2026-08-21, `eintragungAbgleich.ts`).
    //
    // **Unabhaengig von `darfStandplatzSein()`**: eine Eintragung ueberlebt
    // einen Plattformwechsel und darf deshalb auch unter Linux/macOS
    // verschwinden, wenn ihre Community weg ist. Der Abgleich raeumt
    // synchron, das Schreiben laeuft nebenher.
    if (sid && Array.isArray(evt.guilds)) {
      void geraeteAnmeldung.abgleichenMitCommunitys(
        sid,
        evt.guilds.map((g) => g.id),
      );
    }
    // **Standplatz-Geraet anmelden.** Ist DIESER Rechner auf DIESEM Server als
    // Geraet eingetragen, meldet er sich jetzt — und zwar nach jedem `ready`,
    // nicht nur beim ersten: die Anmeldung haengt am Socket und ist nach einem
    // Abriss beim Server weg. Ohne das erneute Melden staende das Geraet fuer
    // alle anderen auf „offline", waehrend es laengst wieder verbunden ist.
    // Auf der Verbindung, die diesen Rahmen gebracht hat — eine Eintragung
    // gehoert einem Server, nicht „dem gerade aktiven".
    //
    // **Nur wo dieser Rechner sich auch wirklich steuern lassen kann.** Eine
    // Eintragung ueberlebt einen Plattformwechsel (dieselbe Datei, anderes
    // Betriebssystem), und ohne diese Pruefung meldete sich ein Linux-Rechner
    // munter weiter an: er stand fuer alle als „bereit", waehrend jede
    // Uebernahme in `remote/session.svelte.ts` schweigend verworfen wurde. Ohne
    // Anmeldung steht er als offline — das entspricht der Wahrheit.
    //
    // **Und erst, wenn die Fähigkeit gemessen ist.** `darfStandplatzSein()`
    // liest `stream.fernsteuerbar`, und das steht nach dem Start eine Weile auf
    // seiner Vorgabe `false` — nicht weil der Rechner nichts kann, sondern weil
    // noch niemand gefragt hat. Die erste Abfrage muss dafür den Sidecar
    // starten (lazy beim ersten `gsr:call`), die WebSocket-Verbindung braucht
    // keinen Prozessstart und ist deshalb regelmässig früher da. Hier stand die
    // Prüfung bis zum 2026-08-26 unmittelbar, gewann das Rennen fast immer —
    // und da es kein Nachmelden gibt, blieb das Gerät die ganze Sitzung lang
    // für alle anderen „offline". Das Tor wartet auf die Messung statt auf eine
    // geratene Frist (`stream/gesundheitTor.ts`).
    if (sid) {
      void gesundheitTor.bekannt().then(() => standplatzAnmelden(sid));
    }
    ctx.onReadySeeded();
  });
}

/**
 * Dieses Gerät auf DIESEM Server als Standplatz anmelden — sofern es dort
 * eingetragen ist und dieser Rechner sich überhaupt steuern lassen kann.
 *
 * Ausgelagert, weil der Aufruf seit dem Warten auf das Gesundheits-Tor in einem
 * eigenen Ablauf steht: die Verbindung kann in der Zwischenzeit weg sein, und
 * `gatewayForServer` beantwortet das erst im Moment des Anmeldens richtig.
 */
function standplatzAnmelden(sid: string): void {
  if (!darfStandplatzSein()) return;
  const eintrag = geraeteAnmeldung.fuerServer(sid);
  const conn = eintrag ? gatewayForServer(sid) : null;
  if (!eintrag || !conn) return;
  // Nach der Anmeldung: hier liegen zum ersten Mal beide Dinge vor, die der
  // einmalige Umzug der alten lokalen Freigabeliste braucht — eine stehende
  // Verbindung und die Eintragung dieses Geräts auf DIESEM Server (Begründung
  // `standplatz.svelte.ts::versucheUmzug`).
  void geraeteAnmeldung
    .anmelden((deviceId, monitore) => conn.sendDeviceAnnounce(deviceId, monitore), eintrag)
    .then(() => standplatz.versucheUmzug(eintrag));
}
