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
  import LoadingState from '$lib/components/feedback/LoadingState.svelte';
  import { m } from '$lib/paraglide/messages.js';

  let channelId = $derived(page.params.channelId ?? '');
  let partyId = $derived(page.params.partyId ?? '');
  let party = $derived(
    channelId && partyId ? watchPartyPresence.partyIn(channelId, partyId) : undefined
  );

  // `window.close()` wirft in manchen Browsern, wenn das Fenster nicht per
  // `window.open` geöffnet wurde — hier ist es immer eins. Einmal gekapselt,
  // damit die vier Aufrufstellen identisch bleiben.
  function closeThisWindow(): void {
    try {
      window.close();
    } catch {
      /* ignore */
    }
  }

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
    // party ever arrived.
    //
    // 600ms war dabei selbst noch zu knapp: das ist die Zeit NACH einem
    // bereits abgeschlossenen `ready` — auf `localhost` unauffällig, über eine
    // echte Leitung (langsamere Reaktivitäts-Weiterleitung, ein Reconnect
    // mittendrin, ein grosser Ready-Frame) reisst das leicht, und das Popup
    // schliesst sich selbst, obwohl die Party noch laeuft (2026-08-31
    // gemeldet: Fenster geht kurz auf und schliesst sich sofort wieder).
    // 3s deckt einen realistischen Kaltstart ab, ohne ein wirklich totes
    // Popup lange offen zu lassen — das zeigt bis dahin ohnehin nur den
    // Ladezustand.
    gateway
      .waitForReady()
      .then(() => {
        if (cancelled) return;
        setTimeout(() => {
          if (!cancelled && !watchPartyPresence.partyIn(channelId, partyId)) {
            closeThisWindow();
          }
        }, 3000);
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
      closeThisWindow();
    }
  });

  onMount(() => {
    // Main hat „close" geschickt (User hat im Hauptfenster auf „Andocken"
    // geklickt) → wir schließen uns.
    const offClose = detachedWatchParties.onCloseRequest((cid, pid) => {
      if (cid === channelId && pid === partyId) closeThisWindow();
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
    <WatchPartyTile {channelId} {party} canDetach={false} canHide={false} onDock={closeThisWindow} />
  {:else}
    <div class="flex h-full w-full items-center justify-center">
      <LoadingState density="page" label={m.watch_popup_loading()} />
    </div>
  {/if}
</div>
