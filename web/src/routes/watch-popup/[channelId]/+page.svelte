<!--
  /watch-popup/[channelId] — Entkoppelte Watch-Party-Ansicht. Eigene
  Gateway-WS im neuen Fenster: bekommt `ready.watch_states` + die Live-
  `watch_state`-Pushes via Gateway-Subscription, syncronisiert seinen Player
  über dieselben Heartbeats wie ein normaler Viewer.

  Host-Übergabe ist implizit: das Hauptfenster zeigt einen Placeholder
  (kein Player gemountet → kein Heartbeat-Effekt → Host-Duties ruhen),
  hier mountet der `WatchPartyTile` → erkennt `isHost=true` → übernimmt
  Heartbeat + Control-Broadcast. Beim Schließen läuft alles rückwärts.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { page } from '$app/state';
  import { gateway } from '$lib/ws/connection';
  import { detachedWatchParties } from '$lib/stream/watchPartyDetach.svelte';
  import { watchPartyPresence } from '$lib/stores/watchPartyPresence.svelte';
  import WatchPartyTile from '$lib/components/WatchPartyTile.svelte';
  import PictureInPicture2Icon from '@lucide/svelte/icons/picture-in-picture-2';

  let channelId = $derived(page.params.channelId ?? '');
  let party = $derived(channelId ? watchPartyPresence.partyIn(channelId) : undefined);

  // Channel-Subscribe: ohne diese Subscribe-Op kriegen wir die per-channel-
  // Pushes (watch_state, watch_chat_message) nicht. Re-subscribe übernimmt
  // gateway selbst beim Reconnect (`_subs`-Set in connection.ts).
  $effect(() => {
    const cid = channelId;
    if (!cid) return;
    gateway.subscribe(cid);
    return () => gateway.unsubscribe(cid);
  });

  // Wenn die Party endet (host hat Stop gedrückt, oder Channel-Bereich
  // verlassen), schließt sich das Popup selbst. Sonst hängt eine tote
  // Fenster-Hülle rum.
  $effect(() => {
    if (!channelId) return;
    // Nach Mount + Subscribe ein paar hundert ms Grace-Period für den
    // ersten `ready`-Snapshot — sonst würden wir uns sofort schließen
    // weil die Party-State noch nicht geladen ist.
    const grace = setTimeout(() => {
      if (!watchPartyPresence.partyIn(channelId)) {
        try { window.close(); } catch {}
      }
    }, 1500);
    return () => clearTimeout(grace);
  });

  // Reagiert auf eine ende-der-party-Push nach dem Initial-Load.
  let hadParty = false;
  $effect(() => {
    const exists = !!party;
    if (exists) hadParty = true;
    else if (hadParty) {
      // Party ist gegangen → Fenster zu.
      try { window.close(); } catch {}
    }
  });

  onMount(() => {
    // Main hat „close" geschickt (User hat im Hauptfenster auf „Andocken"
    // geklickt) → wir schließen uns.
    const offClose = detachedWatchParties.onCloseRequest((cid) => {
      if (cid === channelId) {
        try { window.close(); } catch {}
      }
    });

    function onUnload(): void {
      detachedWatchParties.notifyClosed(channelId);
    }
    window.addEventListener('beforeunload', onUnload);

    return () => {
      offClose();
      window.removeEventListener('beforeunload', onUnload);
    };
  });
</script>

<svelte:head>
  {#if party}<title>Pulse — Watch Party</title>{/if}
</svelte:head>

<div class="relative h-full w-full" data-testid="watch-popup">
  {#if party && channelId}
    <WatchPartyTile {channelId} {party} canDetach={false} />
    <button
      type="button"
      onclick={() => { try { window.close(); } catch {} }}
      class="absolute right-3 top-3 z-20 flex items-center gap-1.5 rounded-full bg-black/70 px-3 py-1.5 text-xs font-medium text-white hover:bg-black/85"
      title="Wieder andocken (schließt dieses Fenster)"
      aria-label="Wieder andocken"
      data-testid="popup-reattach"
    >
      <PictureInPicture2Icon class="size-3.5" />
      <span>Wieder andocken</span>
    </button>
  {:else}
    <div class="flex h-full w-full items-center justify-center text-sm text-text-muted">
      Lade Watch-Party-Status…
    </div>
  {/if}
</div>
