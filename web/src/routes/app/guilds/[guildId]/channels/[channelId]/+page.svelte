<script lang="ts">
  import { onMount, onDestroy, untrack } from 'svelte';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import ChannelList from '$lib/components/ChannelList.svelte';
  import ChannelSwitcherSheet from '$lib/components/mobile/ChannelSwitcherSheet.svelte';
  import GuildRail from '$lib/components/GuildRail.svelte';
  import ChatView from '$lib/components/ChatView.svelte';
  import VoiceChannelView from '$lib/components/VoiceChannelView.svelte';
  import DeviceView from '$lib/devices/components/DeviceView.svelte';
  import { deviceStore } from '$lib/devices/store.svelte';
  import { geraetPfad } from '$lib/devices/darstellung';
  import { kanalAnlegen } from '$lib/channels/anlegen';
  import { erstelleCommunity } from '$lib/guilds/erstellen';
  import type { Device } from '$lib/api/devices';
  import FieldError from '$lib/components/feedback/FieldError.svelte';
  import DropboxView from '$lib/components/DropboxView.svelte';
  import { isPluginEnabledForGuild } from '$lib/plugins';
  import TamagotchiWidget from '../../../../../../../../plugins/tamagotchi/components/TamagotchiWidget.svelte';
  import { Button } from '$lib/components/ui/button/index.js';
  import CreateGuildDialog from '$lib/components/CreateGuildDialog.svelte';
  import CreateChannelDialog from '$lib/components/CreateChannelDialog.svelte';
  import { auth } from '$lib/stores/auth.svelte';
  import { currentServerUserId } from '$lib/stores/currentServerUser';
  import { capabilities } from '$lib/stores/capabilities.svelte';
  import { darfCommunityAnlegen } from '$lib/servers/erstellrecht';
  import { serverAdmin } from '$lib/stores/serverAdmin.svelte';
  import { activeServer } from '$lib/stores/active-server.svelte';
  import { guilds } from '$lib/stores/guilds.svelte';
  import { serverGuilds } from '$lib/stores/serverGuilds.svelte';
  import { messages } from '$lib/stores/messages.svelte';
  import { roles } from '$lib/stores/roles.svelte';
  import { channelPermissions } from '$lib/stores/channelPermissions.svelte';
  import { Perm } from '$lib/permissions/bitfield';
  import { chatApi } from '$lib/api/chat';
  import { dropboxApi } from '$lib/api/dropbox';
  import { joinGuildByInvite } from '$lib/guilds/joinByInvite';
  import { useGatewayDeletedListener, useGatewayListener } from '$lib/ws/useGatewayListener.svelte';
  import { ABLAGE_KANAL_ENABLED } from '$lib/featureFlags';
  import { kanalEreignisEinspeisen } from '$lib/krypto/gruppe/kanalSitzungStore';
  import { kanalWsEreignisAbbilden } from '$lib/krypto/gruppe/kanalEreignisAbbildung';
  import { voice } from '$lib/voice/livekit.svelte';
  import { navDrawer } from '$lib/stores/navDrawer.svelte';
  import { viewport } from '$lib/stores/viewport.svelte';
  import { erstelleKanalWechsel } from '$lib/components/chat/kanalWechsel.svelte';
  import { erstelleKanalNachrichtenAktionen } from '$lib/components/chat/kanalNachrichtenAktionen';
  import type { Channel, Message } from '$lib/api/types';
  import { toast } from 'svelte-sonner';
  import { m as pm } from '$lib/paraglide/messages.js';

  let guildId = $derived(page.params.guildId ?? '');
  let channelId = $derived(page.params.channelId ?? '');
  // ``guilds.byId`` hält nur die Communitys des aktiv verbundenen Servers
  // (der Ready-Handler reapt fremde). Hängt der WS noch auf einem anderen
  // Server, ist der Eintrag hier leer → Fallback auf den multi-server
  // ``serverGuilds``-Cache, damit der Community-Name nicht zu „—" wird.
  let activeGuild = $derived<typeof guilds.byId[string] | undefined>(
    guilds.byId[guildId] ?? serverGuilds.findGuild(guildId)
  );
  // Darf ich auf dem AKTIVEN Server eine Community anlegen? Rechnung in
  // ``lib/servers/erstellrecht.ts`` (eine Stelle für alle drei Aufrufer).
  let canCreateGuild = $derived(
    darfCommunityAnlegen({
      istCloud: activeServer.current?.isCloud ?? false,
      cloudAdmin: !!auth.user?.is_admin,
      rolleLautCloud: activeServer.current?.role ?? null,
      adminLautServer: serverAdmin.has(activeServer.serverId)
        ? serverAdmin.isAdmin(activeServer.serverId)
        : null,
      offenFuerAlle: capabilities.allowGuildCreation,
    }),
  );
  // Admin/Betreiber des aktiven Servers? Cloud → auth.user.is_admin; Self-Host →
  // serverAdmin aus dem Ready-Frame. Admins sind von einer Sperre serverseitig
  // ausgenommen, daher sehen sie eine stillgelegte Community normal.
  let isServerAdmin = $derived(
    (activeServer.current?.isCloud ?? false)
      ? (auth.user?.is_admin ?? false)
      : serverAdmin.isAdmin(activeServer.serverId)
  );
  // Vom Betreiber stillgelegt: für normale Mitglieder ist die ganze Community
  // eingefroren (Server blockt Lesen/Senden mit 403) — statt einer generischen
  // Fehlermeldung zeigen wir eine klare „eingefroren"-Tafel. Admins ausgenommen.
  let guildSuspended = $derived(!!activeGuild?.suspended && !isServerAdmin);
  // Darf ich Kanäle anlegen? Von ChannelList UND ChannelSwitcherSheet gleichermassen
  // gebraucht (Rechner-Spalte vs. Handy-Blatt fuer dieselbe Liste).
  let canManageChannels = $derived(
    !!activeGuild && roles.hasGuildPermission(activeGuild.id, Perm.MANAGE_CHANNELS)
  );
  let channelsForGuild = $derived<Channel[]>(guilds.channelsByGuild[guildId] ?? []);
  let activeChannel = $derived<Channel | null>(
    channelsForGuild.find((c: Channel) => c.id === channelId) ?? null
  );
  let activeChannelId = $derived(activeChannel?.id ?? null);
  let isVoiceChannel = $derived(activeChannel?.type === 1);
  let isDropboxChannel = $derived(activeChannel?.type === 2);
  // Mobil + im Voice + Text-Kanal derselben Community: KEIN Karten-Stapel
  // mehr (2026-08-26, Nutzerwunsch) — die rausschauende Voice-Karte über dem
  // Chat galt als verbuggt. Der Text-Kanal füllt den Bildschirm normal; die
  // Voice-Verbindung läuft weiter und bleibt über das Voice-Dock unter der
  // Navigationsleiste steuerbar. Zurück zum Sprachkanal: Räume-Tab (führt
  // zuletzt dorthin) oder Kanal-Wechsler.
  // Alt-Kanal eingefroren (Entwurf §9, Etappe E9): der Server weist neue
  // Nachrichten serverseitig ab (403/4015), das Eingabefeld erklärt das
  // schon vorher statt still zu scheitern. Verlauf bleibt lesbar.
  let legacyReadonly = $derived(!!activeChannel?.legacy_readonly);

  // Auf Mobil hat ein Voice-Kanal keine eigene Vollbild-Seite: stattdessen
  // bleibt die Kanal-Liste sichtbar (oben Text-, unten Sprachkanäle). Zusätzlich
  // Auto-Rejoin beim Laden/Navigieren auf einen Voice-Kanal — sonst ist man nach
  // einem Reload "auf dem Kanal", aber nicht verbunden (→ Text-Kanal zeigt
  // Vollbild statt Karten-Stapel). Spiegelt das frühere
  // VoiceChannelView.onMount-Auto-Join, das mit der Vollbild-Seite entfiel.
  // Nur EINMAL pro Kanal-Landing (Guard) und untracked gelesen — NICHT reaktiv
  // auf Verbindungsabbruch, sonst würde "Verlassen" sofort wieder beitreten;
  // und nur, wenn wir nirgends im Voice sind (kein Auto-Switch).
  let autoJoinedVoiceChannel = '';
  $effect(() => {
    if (!viewport.isMobile || !isVoiceChannel) return;
    navDrawer.open = true;
    const ch = activeChannel;
    if (!ch || autoJoinedVoiceChannel === ch.id) return;
    autoJoinedVoiceChannel = ch.id;
    untrack(() => {
      if (!voice.connected && !voice.connecting) void voice.connect(ch.id, ch.name);
    });
  });

  // Mobil: Nach dem Auflegen zurück in die Community-Übersicht — die Voice-
  // Vollbild-Ansicht ist ein Detail-Screen ohne Leiste; wer auflegt, will
  // woanders hin, nicht auf einem „Nicht verbunden"-Bildschirm landen. Der
  // Übergang connected → getrennt (nicht verbindend) löst die Navigation aus.
  let voiceWasConnected = $state(false);
  $effect(() => {
    const connected = voice.connected;
    if (
      voiceWasConnected &&
      !connected &&
      !voice.connecting &&
      viewport.isMobile &&
      isVoiceChannel
    ) {
      untrack(() => void goto(`/app/rooms/${guildId}`));
    }
    voiceWasConnected = connected;
  });
  let visibleMessages = $derived(messages.for(channelId));
  // Server-shared Tamagotchi: nur rendern wenn Plugin für die Guild
  // aktiviert (MANAGE_GUILD-Admin-Toggle, siehe `guildPluginsApi`).
  // Auf Mobil weggelassen — die rechte Sidebar ist dort zu eng.
  let currentSrvUserId = $derived(currentServerUserId());
  let showTamagotchi = $derived(
    !viewport.isMobile &&
      !!guildId &&
      !isVoiceChannel &&
      isPluginEnabledForGuild(guildId, 'tamagotchi')
  );

  let creatingGuild = $state(false);
  // Which screen the add-community dialog opens on (rail "+" menu).
  let createGuildMode = $state<'create' | 'join'>('create');
  let creatingChannel = $state(false);
  // Kanal-Wechsler von unten (Handy/Tablet) — loest den seitlichen Drawer ab.
  let wechslerOffen = $state(false);
  // Kanalwechsel + Nachrichten-Aktionen sind ausgelagert (dieselbe Begruendung
  // wie bei `chat/dmKanalWechsel.svelte.ts` fuer die DM-Seite): dort steckt
  // die Rechnung, hier nur die Verdrahtung mit dieser Seite.
  const kanalWechsel = erstelleKanalWechsel();
  const kanalNachrichten = erstelleKanalNachrichtenAktionen();

  $effect(() => {
    const g = guildId;
    const c = channelId;
    void kanalWechsel.switchTo(g, c);
  });

  // Direct-load safety net: switchTo only kicks off `channelPermissions.ensure`
  // when `target !== prevC`, which on the very first render is fine, but a
  // page-reload onto `/app/guilds/X/channels/<voice-id>` could otherwise paint
  // before the overwrite list lands (STREAM/USE_VIDEO deny gates would miss).
  // Re-firing on every channelId change is idempotent — `ensure` short-circuits
  // on a cached entry.
  $effect(() => {
    const cid = channelId;
    if (!cid || cid === '_') return;
    void channelPermissions.ensure(cid).catch(() => undefined);
  });

  // Keep the open channel at the head of the message-cache LRU so it is never
  // evicted while the user is looking at it (even when no new messages load).
  $effect(() => {
    const cid = channelId;
    if (cid && cid !== '_') messages.touch(cid);
  });

  // WS reconnect path: connection.ts calls messages.clearChannel(cid) for every
  // subscribed channel on `open`, which empties byChannel + loadedChannels.
  // switchTo only fires on URL change — so without this effect the user would
  // see an empty chat until they navigate away. We watch for the load flag
  // disappearing *after* we already switched to the channel and re-fetch.
  $effect(() => {
    kanalWechsel.nachladenWennNoetig(channelId, channelsForGuild);
  });

  // Phase 4.5: Deleted-Hooks via Helper — wandern beim Server-Switch mit.
  useGatewayDeletedListener({
    onChannel: handleRemoteChannelDeleted,
    onGuild: handleRemoteGuildDeleted,
  });

  // Ablage-Kanaele (Etappe E6): Mitglieder-/Rechteaenderungen machen eine
  // laufende Kanal-Gruppensitzung ueberholt (`kanalWechselErkennung.ts`).
  // Der Schalter ist Build-Zeit-konstant, die Bedingung also bei jedem
  // Mount identisch — kein bedingter Hook-Aufruf zur Laufzeit.
  if (ABLAGE_KANAL_ENABLED) {
    useGatewayListener((evt) => {
      const kanalEvt = kanalWsEreignisAbbilden(evt);
      if (kanalEvt) kanalEreignisEinspeisen(kanalEvt);
    });
  }

  onMount(() => {
    // Escape schließt Drawer auf Mobil
    function onKeydown(e: KeyboardEvent) {
      if (e.key === 'Escape' && navDrawer.open) navDrawer.open = false;
    }
    window.addEventListener('keydown', onKeydown);

    return () => {
      window.removeEventListener('keydown', onKeydown);
    };
  });

  onDestroy(() => {
    kanalNachrichten.aufraeumen();
  });

  function handleRemoteChannelDeleted(gId: string, cId: string) {
    if (gId === guildId && cId === channelId) {
      // The connection.ts handler already pruned the store + subscription; we
      // just navigate away from the now-gone channel.
      void onChannelDeleted(cId);
    }
  }

  async function handleRemoteGuildDeleted(gId: string) {
    if (gId !== guildId) return;
    await kanalWechsel.handleRemoteGuildDeleted();
  }

  async function selectGuild(id: string) {
    // Server-Icon öffnet immer die Kanal-Liste (Gilde → Text- → Sprachkanäle);
    // kein Auf-/Zu-Toggle mehr. Geschlossen wird sie durch Kanal-Auswahl.
    navDrawer.open = true;
    if (id !== guildId) {
      await goto(`/app/guilds/${id}/channels/_`);
    }
  }

  async function selectChannel(c: Channel) {
    // **Ein offenes Geraet macht den Kanal-Klick NOETIG, obwohl der Kanal schon
    // der aktive ist.** Das Geraet steht in der Adresse (`?device=`) und
    // ersetzt die Kanalansicht; der Kanal-Teil der Adresse bleibt dabei
    // derselbe. Ohne diese Abfrage kuerzt die Gleichheitspruefung unten den
    // Klick als „schon da" ab — und ausgerechnet der Kanal, in dem das Geraet
    // steht, waere der einzige, den man nicht mehr betreten kann.
    const geraetOffen = offenesGeraet !== null;

    // Voice-Kanal auf Mobil: direkt beitreten und die Kanal-Liste offen lassen
    // (keine große Vollbild-Voice-Ansicht). Status erscheint im Dock + inline.
    if (viewport.isMobile && c.type === 1) {
      // Beitreten und hinnavigieren. Frueher blieb der Drawer dabei offen,
      // damit die Liste sichtbar blieb; den Drawer gibt es auf dem Handy nicht
      // mehr, und ohne Ziel-Ansicht saehe man nach dem Tippen nichts.
      void voice.connect(c.id, c.name);
      if (c.id !== channelId || geraetOffen) await goto(`/app/guilds/${guildId}/channels/${c.id}`);
      return;
    }
    navDrawer.open = false;
    if (c.id === channelId && !geraetOffen) return;
    await goto(`/app/guilds/${guildId}/channels/${c.id}`);
  }

  async function createGuild(name: string) {
    await erstelleCommunity(name);
    creatingGuild = false;
  }

  async function joinGuild(linkOrCode: string, confirmed?: boolean) {
    await joinGuildByInvite(linkOrCode, confirmed);
    creatingGuild = false;
  }

  // Die Anlege-Logik lebt in `$lib/channels/anlegen.ts`, weil der
  // Raeume-Bereich denselben Knopf hat (Mobil-Umbau 2026-08-22).
  async function createChannel(name: string, type: number) {
    if (!activeGuild) return;
    if (await kanalAnlegen(activeGuild.id, name, type)) creatingChannel = false;
  }

  async function onChannelDeleted(deletedId: string) {
    await kanalWechsel.onChannelDeleted(guildId, deletedId, channelId);
  }

  async function togglePin(msg: Message) {
    try {
      if (msg.pinned_at) {
        await chatApi.unpinMessage(msg.id);
      } else {
        await chatApi.pinMessage(msg.id);
      }
      // WS pin_update spiegelt den Zustand an alle Kanal-Mitglieder.
    } catch (e) {
      toast.error(
        (e as Error).message.includes('pin_limit_reached') ? pm.pin_limit_reached() : pm.pin_failed()
      );
      console.error(e);
    }
  }

  // **Das geoeffnete Geraet steht in der Adresse** (`?device=`), nicht in einem
  // Zustand: so ueberlebt es einen Neuladen, ist verlinkbar und der
  // Zurueck-Knopf tut, was er soll. Der Kanal in der Adresse bleibt dabei der
  // Standplatz — das Geraet gehoert dorthin, und die Kanalliste hebt beides
  // zusammen hervor.
  const offenesGeraet = $derived.by((): Device | null => {
    const id = page.url.searchParams.get('device');
    return id ? deviceStore.byId(guildId, id) : null;
  });
  const offenesGeraetId = $derived(offenesGeraet?.id ?? null);

  function geraetOeffnen(d: Device): void {
    void goto(geraetPfad(d));
  }
</script>

<!-- Guild-Rail + Channel-Liste: Spalten für Tablet/Rechner. Ein Handy quer
     behält die mobile Ansicht — die linke Spalte bliebe sonst neben der
     Bereichs-Leiste unten stehen. -->
{#if !viewport.istHandy}
<!-- Guild-Rail: immer sichtbar (auch Mobil), Discord-Style. -->
<GuildRail
  guilds={guilds.list}
  activeGuildId={guildId}
  currentUserId={currentSrvUserId}
  onSelect={(g) => selectGuild(g.id)}
  onCreateClick={() => { createGuildMode = 'create'; creatingGuild = true; }}
  onJoinClick={() => { createGuildMode = 'join'; creatingGuild = true; }}
  onHomeClick={() => { navDrawer.open = true; void goto('/app/friends'); }}
  onGuildDeleted={handleRemoteGuildDeleted}
/>

<!-- Channel-Liste: ab `md` als Spalte neben dem Chat. Auf dem Handy gibt es
     sie hier NICHT mehr — dort ist der Kanal-Chat ein Vollbild-Screen, und die
     Kanaele erreicht man ueber den Wechsler von unten (Titel antippen) oder
     ueber die Vollbild-Liste unter `/app/rooms/[guildId]`. Der Drawer vom
     linken Rand ist damit weg und kollidiert nicht mehr mit der
     System-Zurueck-Geste. -->
{#if !viewport.istHandy}
  <ChannelList
    guild={activeGuild ?? null}
    channels={channelsForGuild}
    {activeChannelId}
    onSelect={selectChannel}
    onCreateClick={() => (creatingChannel = true)}
    {onChannelDeleted}
    canCreate={canManageChannels}
    activeDeviceId={offenesGeraetId}
    onSelectDevice={geraetOeffnen}
  />
{/if}
{/if}

{#snippet chatBody()}
  <ChatView
    channel={activeChannel}
    messages={visibleMessages}
    onSend={(text, replyToId, attachmentIds) =>
      kanalNachrichten.sendMessage(guildId, activeChannel, text, replyToId, attachmentIds)}
    onBack={() => goto(`/app/rooms/${guildId}`)}
    onSwitchChannel={() => (wechslerOffen = true)}
    isOwner={!!activeGuild && roles.hasGuildPermission(activeGuild.id, Perm.MANAGE_MESSAGES)}
    composerDisabled={legacyReadonly}
    composerDisabledReason={legacyReadonly ? pm.channel_page_legacy_readonly_reason() : ''}
    onEditMessage={kanalNachrichten.editMessage}
    onDeleteMessage={kanalNachrichten.deleteMessage}
    onToggleReaction={kanalNachrichten.toggleReaction}
    onTogglePin={togglePin}
  />
{/snippet}

<!-- Chat/Voice fuellt hier immer den Bereich.
     **Geaendert mit dem Mobil-Umbau:** vorher blieb auf dem Handy bei einem
     Sprachkanal die Kanalliste stehen, statt eine Vollbild-Ansicht zu oeffnen —
     das ging nur, WEIL die Liste als Drawer daneben lag. Die Liste ist hier
     jetzt weg (Kanaele: Wechsler von unten oder `/app/rooms/[guildId]`), also
     braeuchte dieselbe Bedingung einen leeren Bildschirm. Der Sprachkanal
     bekommt deshalb auch am Telefon seine eigene Ansicht. -->
{#if offenesGeraet}
  <!-- Ein Geraet steht IN einem Kanal, ist aber keiner: es hat keine
       Teilnehmer und keinen Verlauf. Es ersetzt deshalb die Kanalansicht,
       statt neben ihr zu stehen (Entwurf §5: „Anklicken oeffnet das Geraet im
       Hauptbereich, wie ein Kanal"). -->
  {#key offenesGeraet.id}
    <DeviceView
      device={offenesGeraet}
      onOpenChannel={(cid) => goto(`/app/guilds/${guildId}/channels/${cid}`)}
    />
  {/key}
{:else if isVoiceChannel && activeChannel}
  {#key activeChannel.id}
    <VoiceChannelView channel={activeChannel} />
  {/key}
{:else if isDropboxChannel && activeChannel}
  {#key activeChannel.id}
    <DropboxView channel={activeChannel} />
  {/key}
{:else if guildSuspended}
  <section
    class="glass-panel flex h-full min-w-0 flex-1 flex-col items-center justify-center gap-3 rounded-none p-8 text-center md:rounded-2xl"
    data-testid="community-suspended"
  >
    <h2 class="text-text-bright text-lg font-semibold">{pm.community_suspended_title()}</h2>
    <p class="text-text-muted max-w-sm text-sm">{pm.community_suspended_body()}</p>
  </section>
{:else if kanalWechsel.loadError}
  <section class="glass-panel flex h-full min-w-0 flex-1 flex-col items-center justify-center gap-4 rounded-none p-8 md:rounded-2xl">
    <FieldError message={kanalWechsel.loadError} testId="load-error" />
    <Button
      onclick={() => kanalWechsel.retry(guildId, channelId)}
      data-testid="load-retry"
    >{pm.channel_page_retry()}</Button>
  </section>
{:else}
  {@render chatBody()}
{/if}

<!--
  Server-shared Plugin-Rail (rechts neben ChatView/MemberList). Heute nur
  Tamagotchi; ein weiteres Plugin würde sich hier reihen. Bewusst NICHT
  über das alte UI-Slot-Pattern, weil es das erst in einem späteren PR
  geben wird. Mobile + Voice-Channels haben kein Widget — Begründung
  liegt im `showTamagotchi`-Derived oben.

  Die Width-Klasse ist absichtlich schmal (`w-56`) damit die ChatView
  + MemberList den meisten Raum behalten.
-->
{#if showTamagotchi && activeChannel}
  <aside
    class="border-border bg-bg-chat hidden h-full w-56 shrink-0 flex-col gap-2 overflow-y-auto border-l p-2 md:flex md:rounded-2xl md:border-0"
    data-testid="guild-plugin-rail"
  >
    <h2 class="text-text-muted px-2 pt-1 text-xs font-bold uppercase tracking-wide">
      {pm.channel_page_community_pets()}
    </h2>
    <TamagotchiWidget {guildId} />
  </aside>
{/if}

<CreateGuildDialog
  open={creatingGuild}
  canCreate={canCreateGuild}
  initialMode={createGuildMode}
  onClose={() => (creatingGuild = false)}
  onCreate={createGuild}
  onJoin={joinGuild}
/>

<ChannelSwitcherSheet
  bind:open={wechslerOffen}
  guild={activeGuild ?? null}
  channels={channelsForGuild}
  {activeChannelId}
  onSelect={selectChannel}
  onCreateClick={() => (creatingChannel = true)}
  {onChannelDeleted}
  canCreate={canManageChannels}
  activeDeviceId={offenesGeraetId}
  onSelectDevice={geraetOeffnen}
/>

<CreateChannelDialog
  open={creatingChannel}
  guildId={activeGuild?.id ?? ''}
  dropboxAllowed={activeGuild?.dropbox_allowed ?? false}
  onClose={() => (creatingChannel = false)}
  onCreate={createChannel}
/>
