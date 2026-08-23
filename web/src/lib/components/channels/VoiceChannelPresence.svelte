<script lang="ts">
  /**
   * Wer in einem Sprachkanal sitzt — Namen, Abzeichen, fremde Bildschirmströme,
   * Watch-Partys und der räumliche Klang-Steller.
   *
   * Aus `ChannelVoiceSection.svelte` herausgelöst, weil die Sprachkanal-Zeile
   * damit dreimal so lang war wie eine Textkanal-Zeile. Der Schnitt liegt an
   * der natürlichen Naht: alles hier hängt an den Teilnehmern eines Kanals,
   * nichts an der Zeile selbst. Markup unverändert, `data-testid` identisch.
   */
  import { voice } from '$lib/voice/livekit.svelte';
  import { inVoiceChannel } from '$lib/voice/state.svelte';
  import { voicePresence, type UserVoiceState } from '$lib/stores/voicePresence.svelte';
  import { streamPresence } from '$lib/stores/streamPresence.svelte';
  import { stromGehoertGeraet } from '$lib/devices/darstellung';
  import { watchPartyPresence } from '$lib/stores/watchPartyPresence.svelte';
  import { openedTiles } from '$lib/stream/openedTiles.svelte';
  import { chooseHqForUser } from '$lib/stream/hqTile';
  import { watchPartyPicker, openPartyTile } from '$lib/watch/openParty.svelte';
  import { userIdFromIdentity } from '$lib/voice/identity';
  import { settings } from '$lib/stores/settings.svelte';
  import { viewport } from '$lib/stores/viewport.svelte';
  import VoiceChannelMembers from '../VoiceChannelMembers.svelte';
  import SpatialPositionerPanel from '../SpatialPositionerPanel.svelte';
  import type { Channel } from '$lib/api/types';
  import { m } from '$lib/paraglide/messages.js';

  let {
    channel,
    myId,
    onSelect
  }: {
    channel: Channel;
    myId: string | null;
    onSelect: (c: Channel) => void;
  } = $props();

  // Als abgeleiteter Wert statt `{@const}`: an der Wurzel einer Komponente
  // ist ein `{@const}` nicht erlaubt, es braucht einen Block als Elternteil.
  let members = $derived(voicePresence.usersIn(channel.id));

  // Mute/Deafen für die Liste: Basis ist die Server-Presence (einzige Quelle
  // für Kanäle, in denen wir nicht sind). Für den Kanal, mit dem wir VERBUNDEN
  // sind, überlagern wir das Live-Mute aus dem LiveKit-Store — so ist die Liste
  // deckungsgleich mit der mittleren VoiceChannelView (auch bei OS-Mutes beim
  // Handy-Sperren, die nie über die Server-Presence laufen). Remote-Deafen
  // kennt LiveKit nicht (reines App-Flag) → bleibt aus der Presence; das eigene
  // Deafen ziehen wir live. Berührt NUR die Mute-Anzeige, nicht die
  // Mitgliederliste (die kommt weiter aus voicePresence.usersIn).
  function memberStatesFor(channelId: string): Record<string, UserVoiceState> {
    const base = voicePresence.userStatesIn(channelId);
    if (!(voice.connected && voice.channelId === channelId)) return base;
    const merged: Record<string, UserVoiceState> = { ...base };
    for (const p of voice.participants) {
      if (!p.userId) continue;
      merged[p.userId] = {
        mic_muted: p.micMuted,
        deafened: p.isLocal ? voice.deafened : (merged[p.userId]?.deafened ?? false)
      };
    }
    return merged;
  }
</script>

  {#if members.length > 0}
    {@const voiceStreamers = voicePresence.streamingIn(channel.id)}
    <!-- HQ-Stroeme, die in Wahrheit vom Standplatz-Geraet kommen, gehoeren
         NICHT an die Zeile des Menschen: das Abzeichen stuende sonst
         zweimal da (am Rechner und am Besitzer), und beim Besitzer waere es
         falsch — der muss nicht einmal im Kanal sein. Ein ueber Voice
         geteilter Bildschirm (`voiceStreamers`) bleibt unangetastet. -->
    {@const streamers = [
      ...new Set([
        ...voiceStreamers,
        ...streamPresence.streamersIn(channel.id).filter((uid) => !stromGehoertGeraet(channel.id, uid)),
      ]),
    ]}
    {@const speakers =
      voice.connected && voice.channelId === channel.id
        ? voice.participants.filter((p) => p.isSpeaking && p.userId).map((p) => p.userId!)
        : []}
    {@const memberStates = memberStatesFor(channel.id)}
    {@const partyHostIds = watchPartyPresence.hostIdsIn(channel.id)}
    <!-- Who has their webcam on — server-tracked (voice:events), so the CAM
         badge shows for everyone incl. ourselves and even when we're not
         connected to this channel. Opening the cam tile still needs a
         subscribed track, which only exists while connected. -->
    {@const camUserIds = voicePresence.cameraIn(channel.id)}
    {@const camIdentityFor = (uid: string) =>
      !(voice.connected && voice.channelId === channel.id)
        ? undefined
        : uid === myId
          ? 'self' // own preview tile uses the 'self' sentinel id (StreamGrid)
          : voice.cameraTracks.find((ct) => userIdFromIdentity(ct.identity) === uid)?.identity}
    <div class="ml-4 flex flex-col" data-testid="voice-presence-list" data-channel-id={channel.id}>
      <VoiceChannelMembers
        userIds={members}
        channelId={channel.id}
        guildId={channel.guild_id}
        streamingUserIds={streamers}
        camUserIds={camUserIds}
        speakingUserIds={speakers}
        watchPartyHostUserIds={partyHostIds}
        userStates={memberStates}
        onPartyOpen={(uid) => {
          watchPartyPicker.choose(
            watchPartyPresence.partiesHostedBy(channel.id, uid).map((party) => ({
              id: party.party_id,
              party,
              open: () => {
                openPartyTile(channel.id, party);
                onSelect(channel);
              }
            })),
            m.watch_party_picker_title()
          );
        }}
        onLiveOpen={(uid) => {
          // Open whichever live source(s) this user actually has.
          if (streamers.includes(uid)) {
            chooseHqForUser(channel.id, uid);
          }
          if (voiceStreamers.includes(uid)) {
            // Screen-share keyed by LiveKit identity — only available
            // if we're connected to this channel. Outside that, the
            // tile can't mount anyway (no subscribed track).
            const ident = voice.connected && voice.channelId === channel.id
              ? voice.screenTracks.find((s) => userIdFromIdentity(s.identity) === uid)?.identity
              : undefined;
            if (ident) openedTiles.open('screen', channel.id, ident);
          }
          onSelect(channel);
        }}
        onCamOpen={(uid) => {
          const ident = camIdentityFor(uid);
          if (ident) openedTiles.open('cam', channel.id, ident);
          onSelect(channel);
        }}
      />
    </div>
    {#if settings.audio.spatialMode !== 'off' && voice.connected && voice.channelId === channel.id && !viewport.isMobile}
      <!-- Spatial on + connected here: the drag circle sits BELOW the member
           list. The list stays for names, badges and stream/cam/party
           actions; the circle is purely for arranging everyone around you. -->
      <div data-testid="voice-presence-spatial" data-channel-id={channel.id}>
        <SpatialPositionerPanel size={200} />
      </div>
    {/if}
  {/if}
