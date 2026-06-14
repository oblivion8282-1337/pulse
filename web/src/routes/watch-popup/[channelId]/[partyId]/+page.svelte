<!--
  /watch-popup/[channelId]/[partyId] — Entkoppelte Watch-Party-Ansicht. Eigene
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
  import { m } from '$lib/paraglide/messages.js';

  let channelId = $derived(page.params.channelId ?? '');
  let partyId = $derived(page.params.partyId ?? '');
  let party = $derived(
    channelId && partyId ? watchPartyPresence.partyIn(channelId, partyId) : undefined
  );

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
    let cancelled = false;
    // Self-close only AFTER the gateway has delivered its `ready` snapshot —
    // that's the first moment we'd actually know whether the party exists. A
    // fixed timer raced the popup's cold-start (auth → connect → ready can
    // exceed any fixed grace) and closed the window before the still-alive
    // party ever arrived. A short settle lets the seeded `watch_state` apply.
    gateway
      .waitForReady()
      .then(() => {
        if (cancelled) return;
        setTimeout(() => {
          if (!cancelled && !watchPartyPresence.partyIn(channelId, partyId)) {
            try {
              window.close();
            } catch {
              /* ignore */
            }
          }
        }, 600);
      })
      .catch(() => {
        /* never became ready — the layout's auth guard handles that path */
      });
    return () => {
      cancelled = true;
    };
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
    const offClose = detachedWatchParties.onCloseRequest((cid, pid) => {
      if (cid === channelId && pid === partyId) {
        try { window.close(); } catch {}
      }
    });

    function onUnload(): void {
      detachedWatchParties.notifyClosed(channelId, partyId);
    }
    window.addEventListener('beforeunload', onUnload);

    return () => {
      offClose();
      window.removeEventListener('beforeunload', onUnload);
    };
  });
</script>

<svelte:head>
  {#if party}<title>{m.watch_popup_title()}</title>{/if}
</svelte:head>

<div class="relative h-full w-full" data-testid="watch-popup">
  {#if party && channelId}
    <WatchPartyTile {channelId} {party} canDetach={false} />
    <button
      type="button"
      onclick={() => { try { window.close(); } catch {} }}
      class="absolute right-3 top-3 z-20 flex items-center gap-1.5 rounded-full bg-black/70 px-3 py-1.5 text-xs font-medium text-white hover:bg-black/85"
      title={m.watch_popup_reattach_title()}
      aria-label={m.watch_popup_reattach_label()}
      data-testid="popup-reattach"
    >
      <PictureInPicture2Icon class="size-3.5" />
      <span>{m.watch_popup_reattach_label()}</span>
    </button>
  {:else}
    <div class="flex h-full w-full items-center justify-center text-sm text-text-muted">
      {m.watch_popup_loading()}
    </div>
  {/if}
</div>
