<script lang="ts">
  import { onDestroy } from 'svelte';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import GuildRail from '$lib/components/GuildRail.svelte';
  import DMChannelList from '$lib/components/DMChannelList.svelte';
  import MobileChatsList from '$lib/components/mobile/MobileChatsList.svelte';
  import ChatView from '$lib/components/ChatView.svelte';
  import FieldError from '$lib/components/feedback/FieldError.svelte';
  import { auth } from '$lib/stores/auth.svelte';
  import { currentServerUserId } from '$lib/stores/currentServerUser';
  import { guilds } from '$lib/stores/guilds.svelte';
  import { directMessages } from '$lib/stores/directMessages.svelte';
  import { privateGruppen } from '$lib/stores/privateGruppen.svelte';
  import { userCache } from '$lib/stores/users.svelte';
  import { messages } from '$lib/stores/messages.svelte';
  import { chatApi } from '$lib/api/chat';
  import { verlaufZustand } from '$lib/verlauf/zustand.svelte';
  import { serversStore } from '$lib/api/servers.svelte';
  import { navDrawer } from '$lib/stores/navDrawer.svelte';
  import { selectGuild, selectDM as selectDmRail } from '$lib/navigation/railNavi';
  import { viewport } from '$lib/stores/viewport.svelte';
  import { toast } from 'svelte-sonner';
  import { E2E_DMS_ENABLED, PRIVATE_GRUPPEN_ENABLED } from '$lib/krypto/schalter';
  import { schloss } from '$lib/krypto/schloss.svelte';
  import { dmSendeSperre } from '$lib/krypto/dmSendeSperre';
  import { wandEntscheidung } from '$lib/krypto/dmOhneAppGeraet';
  import { isCapacitorAndroid, isElectron } from '$lib/platform/runtime';
  import DmOhneAppGeraet from '$lib/components/dm/DmOhneAppGeraet.svelte';
  import type { AnhangAngabe } from '$lib/krypto/nachrichtNutzlast';
  import type { DMChannel, Message } from '$lib/api/types';
  import { m } from '$lib/paraglide/messages.js';
  import { berechneSynthChannel } from '$lib/components/chat/dmSynthChannel';
  import { erstelleDmKanalWechsel } from '$lib/components/chat/dmKanalWechsel.svelte';
  import { sendeDmNachricht } from '$lib/components/chat/dmSenden';
  import {
    nachrichtBearbeiten,
    nachrichtLoeschen,
    reaktionUmschalten
  } from '$lib/components/chat/cloudNachrichtAktionen';

  // Global-Friends Stufe 1: DMs leben in der Cloud. Alle DM-REST-Calls werden
  // explizit gegen den Cloud-Server geroutet (sonst laufen sie bei aktivem
  // Self-Host gegen den falschen Server), WS-DM-Ops gehen über `cloudGateway`.
  const cloudRoute = { serverId: serversStore.cloudId() };

  let dmChannelId = $derived(page.params.dmChannelId ?? '');
  let activeDM = $derived<DMChannel | undefined>(
    dmChannelId ? directMessages.byId[dmChannelId] : undefined
  );
  // Eine private Gruppe (Etappe G) laeuft ueber DIESELBE Adresse: Kanal-IDs
  // sind Snowflakes aus EINEM Generator und ueber alle drei Kanalarten
  // eindeutig (Modell-Docstring von `DirectMessageChannel`), `/app/@me/<id>`
  // ist damit nicht mehrdeutig. Eine zweite Route daneben haette dieselbe
  // Ansicht ein zweites Mal gebraucht — und mit ihr Anhaenge, Antworten,
  // Reaktionen und das Aktionsblatt still verloren.
  let aktiveGruppe = $derived(dmChannelId ? privateGruppen.byId[dmChannelId] : undefined);

  // ChatView expects a `Channel`-shaped object. Synthesise one — `guild_id` is
  // empty, but we also pass showMemberList={false} so no member-list lookup
  // happens. Der Name ist bei einer DM der Anzeigename der Gegenstelle (aus
  // `userCache`, faellt beim Laden auf „…" zurueck), bei einer Gruppe ihr
  // eigener. Rechnung importfrei in `chat/dmSynthChannel.ts`.
  let synthChannel = $derived(
    berechneSynthChannel(activeDM, aktiveGruppe, (userId) => userCache.displayName(userId))
  );

  let visibleMessages = $derived(dmChannelId ? messages.for(dmChannelId) : []);

  // Spec §3a: ohne App-Geraet gibt es keine Direktnachrichten — kann die
  // Gegenseite nicht teilnehmen, sperrt das Eingabefeld (Rechnung importfrei
  // in `krypto/dmSendeSperre.ts`). Der Stand kommt aus einer Route, die
  // nichts verbraucht, genau einmal je Gegenstelle (`schlossAbfrage.ts`);
  // `POST /keys/claim` wuerde Einmalschluessel verbrauchen — deshalb NICHT.
  $effect(() => {
    if (activeDM) schloss.sicherstellen(activeDM.other_user_id);
  });
  let dmSperre = $derived(
    activeDM
      ? dmSendeSperre(E2E_DMS_ENABLED, activeDM.can_send !== false, schloss.stand(activeDM.other_user_id))
      : null
  );

  // Spec §3a Punkt 1: dieselbe Frage wie oben, aber fuer das EIGENE Konto,
  // ueber dieselbe Route (`darf_schluessel_holen` erlaubt das eigene Konto
  // ausdruecklich). Ohne mindestens ein eigenes App-Geraet gibt es fuer
  // dieses Konto keine Direktnachrichten — der Bildschirm tritt an die
  // Stelle der Liste, statt sie leer zu lassen. Wand-Entscheidung und
  // -Auspraegung importfrei (`krypto/dmOhneAppGeraet.ts`); in App-Kontexten
  // (dieselbe Erkennung wie `veroeffentlichen.ts::eigenesGeraetDauerhaft`)
  // bietet der Bildschirm die Einrichtung DIESES Geraets an (B11).
  const appKontext = isElectron() || isCapacitorAndroid();
  $effect(() => {
    if (auth.user) schloss.sicherstellen(auth.user.id);
  });
  let wandArt = $derived(
    wandEntscheidung(E2E_DMS_ENABLED, appKontext, auth.user ? schloss.stand(auth.user.id) : undefined)
  );

  // Umschalten zwischen Gespraechen (Laden, Abonnieren, Nachhol-Bestellungen)
  // ausgelagert — s. `chat/dmKanalWechsel.svelte.ts`.
  const kanalWechsel = erstelleDmKanalWechsel(cloudRoute);
  const pendingOptimisticTimeouts = new Map<string, ReturnType<typeof setTimeout>>();

  // Mirrors the channel-page effect: when the DM id in the URL changes, load
  // messages + subscribe + leave the previous one. The DM record itself is
  // already in the store (seeded by ready / hydrate / dm_bump).
  $effect(() => {
    void kanalWechsel.switchTo(dmChannelId);
  });

  // Keep the open DM at the head of the message-cache LRU so it is never
  // evicted while the user is viewing it.
  $effect(() => {
    if (dmChannelId) messages.touch(dmChannelId);
  });

  // C2: der Nutzer erfaehrt EINMAL, warum sein Verlauf nicht lokal liegt
  // (privates Fenster/voller Speicher/Fehler) — die App bleibt in jedem Fall
  // benutzbar (Rueckfall auf den Server), s. `verlaufZustand`.
  let verlaufHinweisGezeigt = false;
  $effect(() => {
    if (verlaufZustand.grund && !verlaufHinweisGezeigt) {
      verlaufHinweisGezeigt = true;
      toast.warning(verlaufZustand.grund);
    }
  });

  // WS reconnect: messages.clearChannel() may empty the loaded set. Re-fetch
  // if we're still parked on this DM.
  $effect(() => {
    kanalWechsel.nachladenWennNoetig(dmChannelId);
  });

  // Prime the user cache for the other user of every DM so the sidebar +
  // header name resolve without a flash of "…".
  $effect(() => {
    for (const dm of directMessages.list) userCache.queue(dm.other_user_id);
  });

  onDestroy(() => {
    for (const handle of pendingOptimisticTimeouts.values()) clearTimeout(handle);
    pendingOptimisticTimeouts.clear();
    kanalWechsel.aufraeumen();
  });

  // Server-Icon ist der Drawer-Trigger — `selectGuild` aus dem geteilten
  // Helfer in `$lib/navigation/railNavi.ts`.
  // DM-Klick auf die schon offene DM: kein Navigieren (sonst Scroll-Sprung).
  async function selectDM(dm: DMChannel) {
    if (dm.id === dmChannelId) return;
    await selectDmRail(dm);
  }

  /** Dieselbe Adresse wie eine DM — s. `aktiveGruppe` oben. Der Rueckruf wird
   *  den Listen nur bei eingeschaltetem Schalter gegeben; ohne ihn zeigen sie
   *  keinen Gruppen-Abschnitt. */
  const selectGruppe = PRIVATE_GRUPPEN_ENABLED
    ? async (gruppeId: string) => {
        navDrawer.open = false;
        if (gruppeId === dmChannelId) return;
        await goto(`/app/@me/${gruppeId}`);
      }
    : undefined;

  // Sende-Einstieg (Gruppe / verschluesselte DM / Klartext-DM) ausgelagert —
  // s. `chat/dmSenden.ts`.
  function sendMessage(
    text: string,
    replyToId: string | null,
    attachmentIds: string[],
    anhaenge: AnhangAngabe[] = []
  ) {
    sendeDmNachricht({
      userId: auth.user?.id ?? null,
      aktiveGruppe,
      activeDM,
      visibleMessages,
      text,
      replyToId,
      attachmentIds,
      anhaenge,
      e2eDmsEnabled: E2E_DMS_ENABLED,
      cloudRoute,
      pendingOptimisticTimeouts
    });
  }

  const editMessage = (msg: Message, content: string) =>
    nachrichtBearbeiten(msg, content, cloudRoute);
  const deleteMessage = (msg: Message) => nachrichtLoeschen(msg, cloudRoute);
  const toggleReaction = (msg: Message, emoji: string, currentlyMine: boolean) =>
    reaktionUmschalten(msg, emoji, currentlyMine, cloudRoute);

  async function togglePin(msg: Message) {
    try {
      if (msg.pinned_at) {
        await chatApi.unpinMessage(msg.id, cloudRoute);
      } else {
        await chatApi.pinMessage(msg.id, cloudRoute);
      }
    } catch (e) {
      // WS pin_update spiegelt den Zustand — bei Fehler bleibt die UI konsistent.
      toast.error(
        (e as Error).message.includes('pin_limit_reached') ? m.pin_limit_reached() : m.pin_failed()
      );
      console.error(e);
    }
  }
</script>

<GuildRail
  guilds={guilds.list}
  activeGuildId={''}
  currentUserId={currentServerUserId()}
  homeActive={true}
  onSelect={selectGuild}
  onCreateClick={() => goto('/app?add=create')}
  onJoinClick={() => goto('/app?add=join')}
  onHomeClick={async () => {
    navDrawer.open = !navDrawer.open;
    await goto('/app/friends');
  }}
/>

<!-- Die Liste bleibt IMMER erreichbar — Freunde und (Community-)Einladungen
     laufen unverschluesselt und haben mit dem Geraet-Stand nichts zu tun; die
     Wand hierunter haette sie verschluckt (Fehlerbefund 2026-09-02). -->
<!-- DM-Liste. Auf dem Handy ist sie der Chats-Bereich und fuellt den
     Bildschirm, solange kein Gespraech offen ist — kein Drawer mehr, damit der
     Bildschirmrand der System-Zurueck-Geste gehoert. Ab `md` wieder die
     schmale Seitenleiste neben dem Chat. -->
{#if viewport.isMobile}
  {#if !dmChannelId}
    <MobileChatsList onSelect={selectDM} onSelectGruppe={selectGruppe} />
  {/if}
{:else}
  <DMChannelList
    activeDMId={dmChannelId || null}
    onSelect={selectDM}
    onSelectGruppe={selectGruppe}
  />
{/if}

<!-- Chat-Bereich: Spec §3a Punkt 1 — ohne eigenes App-Geraet gibt es fuer
     dieses Konto keine Direktnachrichten; die Wand ersetzt NUR den Chat, die
     Liste daneben bleibt. Die Auspraegung (App: Geraet einrichten / Browser:
     Apps + Kopplung) entscheidet `wandEntscheidung`. -->
{#if wandArt !== 'keine'}
  <DmOhneAppGeraet art={wandArt} />
{:else if !viewport.isMobile || !!dmChannelId}
  {#if kanalWechsel.loadError}
    <section
      class="glass-panel flex h-full min-w-0 flex-1 flex-col items-center justify-center gap-4 rounded-none p-8 md:rounded-2xl"
    >
      <FieldError message={kanalWechsel.loadError} testId="load-error" />
    </section>
  {:else if aktiveGruppe && synthChannel}
    <!-- Dieselbe Ansicht wie bei einer DM, nur mit anderer Huelle im Kopf und
         Zeilen- statt Sprechblasen-Darstellung. Eine eigene Gruppen-Ansicht
         daneben haette Anhaenge, Antworten, Reaktionen und das Aktionsblatt
         still verloren. -->
    <ChatView
      channel={synthChannel}
      messages={visibleMessages}
      onSend={sendMessage}
      headerKind="gruppe"
      onBack={() => goto('/app/@me')}
      cloudScoped
      showMemberList={false}
      onEditMessage={editMessage}
      onDeleteMessage={deleteMessage}
      onToggleReaction={toggleReaction}
    />
  {:else if activeDM && synthChannel}
    <ChatView
      channel={synthChannel}
      messages={visibleMessages}
      onSend={sendMessage}
      headerKind="dm"
      dmPartnerId={activeDM.other_user_id}
      onBack={() => goto('/app/@me')}
      cloudScoped
      verschluesselteAnhaenge={E2E_DMS_ENABLED}
      showMemberList={false}
      composerDisabled={dmSperre !== null}
      composerDisabledReason={dmSperre === 'ohne_app'
        ? m.dm_page_composer_ohne_app_reason()
        : m.dm_page_composer_disabled_reason()}
      onEditMessage={editMessage}
      onDeleteMessage={deleteMessage}
      onToggleReaction={toggleReaction}
      onTogglePin={togglePin}
    />
  {:else}
    <section
      class="glass-panel flex h-full min-w-0 flex-1 flex-col items-center justify-center gap-2 rounded-none p-8 md:rounded-2xl"
      data-testid="dm-empty-state"
    >
      <p class="text-text-bright text-base font-semibold">{m.dm_page_empty_title()}</p>
      <p class="text-text-muted max-w-sm text-center text-sm">
        {m.dm_page_empty_hint()}
      </p>
    </section>
  {/if}
{/if}
