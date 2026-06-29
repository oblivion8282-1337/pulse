<!--
  /stream-popup/[channelId]/[userId] — Entkoppelte HQ-Stream-Ansicht. Wird
  vom Hauptfenster via `detachedStreams.open(cid, uid, slot)` per `window.open()`
  gestartet, das Popup hat seinen eigenen JS-Context (eigene WHEP-Connection,
  eigene Gateway-WS, eigener Live-Chat-Subscribe).

  Sync mit dem Hauptfenster via BroadcastChannel:
    * onCloseRequest('close', cid, uid, slot) → wir schließen uns selbst
    * beforeunload                        → wir melden 'closed' damit das
                                            Hauptfenster den Player wieder
                                            inline anzeigt.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { page } from '$app/state';
  import { gateway } from '$lib/ws/connection';
  import { detachedStreams } from '$lib/stream/detach.svelte';
  import { hqStreams } from '$lib/stream/hqStreamManager.svelte';
  import { userCache } from '$lib/stores/users.svelte';
  import WhepPlayer from '$lib/stream/components/WhepPlayer.svelte';
  import PictureInPicture2Icon from '@lucide/svelte/icons/picture-in-picture-2';
  import { m } from '$lib/paraglide/messages.js';

  let channelId = $derived(page.params.channelId ?? '');
  let userId = $derived(page.params.userId ?? '');
  // Which of the user's streams this popup shows (0 = primary). Comes as a
  // ?slot=N query so the route file stays [channelId]/[userId].
  let streamSlot = $derived(Number(page.url.searchParams.get('slot') ?? '0') || 0);
  let streamerName = $derived(userId ? userCache.displayName(userId) : '');

  $effect(() => {
    if (userId) userCache.queue(userId);
  });

  // Channel-Subscribe für Live-Chat-Pushes. Re-subscribe wird vom gateway
  // selbst beim Reconnect erledigt (siehe `_subs` in connection.ts).
  $effect(() => {
    const cid = channelId;
    if (!cid) return;
    gateway.subscribe(cid);
    return () => gateway.unsubscribe(cid);
  });

  // Im Popup gibt es keinen Keep-Alive-Abgleicher (der lebt im App-Layout) —
  // deshalb die WHEP-Verbindung hier selbst sauber abbauen (pc.close + DELETE),
  // wenn das Popup-Fenster geschlossen wird.
  $effect(() => {
    const cid = channelId;
    const uid = userId;
    const slot = streamSlot;
    if (!cid || !uid) return;
    return () => hqStreams.close(cid, uid, slot);
  });

  onMount(() => {
    // Hauptfenster fordert das Schließen an (z.B. Streamer offline, oder
    // User klickt "wieder andocken" im Hauptfenster) → wir schließen uns.
    const offClose = detachedStreams.onCloseRequest((cid, uid, slot) => {
      if (cid === channelId && uid === userId && slot === streamSlot) {
        try { window.close(); } catch {}
      }
    });

    // Wenn das Popup geschlossen wird (vom User per OS-X oder programmatisch),
    // melden wir das dem Hauptfenster damit es den Player wieder inline mountet.
    function onUnload(): void {
      detachedStreams.notifyClosed(channelId, userId, streamSlot);
    }
    window.addEventListener('beforeunload', onUnload);

    return () => {
      offClose();
      window.removeEventListener('beforeunload', onUnload);
    };
  });
</script>

<svelte:head>
  {#if streamerName}
    <title>{m.stream_popup_title({ streamerName })}</title>
  {/if}
</svelte:head>

<div class="relative h-full w-full" data-testid="stream-popup">
  {#if channelId && userId}
    <WhepPlayer
      {channelId}
      {userId}
      {streamSlot}
      name={streamerName}
      canDetach={false}
      canHide={false}
    />
    <!-- Reattach button — closing the window via the OS X fires the same
         notifyClosed → Hauptfenster mountet das Tile inline wieder
         (sobald der Viewer das Sidebar-Symbol erneut klickt). -->
    <button
      type="button"
      onclick={() => { try { window.close(); } catch {} }}
      class="absolute right-3 top-3 z-20 flex items-center gap-1.5 rounded-full bg-black/70 px-3 py-1.5 text-xs font-medium text-white hover:bg-black/85"
      title={m.stream_popup_reattach_title()}
      aria-label={m.stream_popup_reattach_label()}
      data-testid="popup-reattach"
    >
      <PictureInPicture2Icon class="size-3.5" />
      <span>{m.stream_popup_reattach_label()}</span>
    </button>
  {:else}
    <div class="flex h-full w-full items-center justify-center text-sm text-text-muted">
      {m.stream_popup_invalid_link()}
    </div>
  {/if}
</div>
