<!--
  /stream-popup/[channelId]/[userId] — Entkoppelte HQ-Stream-Ansicht. Wird
  vom Hauptfenster via `detachedStreams.open(cid, uid)` per `window.open()`
  gestartet, das Popup hat seinen eigenen JS-Context (eigene WHEP-Connection,
  eigene Gateway-WS, eigener Live-Chat-Subscribe).

  Sync mit dem Hauptfenster via BroadcastChannel:
    * onCloseRequest('close', cid, uid) → wir schließen uns selbst
    * beforeunload                        → wir melden 'closed' damit das
                                            Hauptfenster den Player wieder
                                            inline anzeigt.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { page } from '$app/state';
  import { gateway } from '$lib/ws/connection';
  import { detachedStreams } from '$lib/stream/detach.svelte';
  import { userCache } from '$lib/stores/users.svelte';
  import WhepPlayer from '$lib/stream/components/WhepPlayer.svelte';
  import PictureInPicture2Icon from '@lucide/svelte/icons/picture-in-picture-2';

  let channelId = $derived(page.params.channelId ?? '');
  let userId = $derived(page.params.userId ?? '');
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

  onMount(() => {
    // Hauptfenster fordert das Schließen an (z.B. Streamer offline, oder
    // User klickt "wieder andocken" im Hauptfenster) → wir schließen uns.
    const offClose = detachedStreams.onCloseRequest((cid, uid) => {
      if (cid === channelId && uid === userId) {
        try { window.close(); } catch {}
      }
    });

    // Wenn das Popup geschlossen wird (vom User per OS-X oder programmatisch),
    // melden wir das dem Hauptfenster damit es den Player wieder inline mountet.
    function onUnload(): void {
      detachedStreams.notifyClosed(channelId, userId);
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
    <title>Pulse — {streamerName}</title>
  {/if}
</svelte:head>

<div class="relative h-full w-full" data-testid="stream-popup">
  {#if channelId && userId}
    <WhepPlayer {channelId} {userId} name={streamerName} canDetach={false} canHide={false} />
    <!-- Reattach button — closing the window via the OS X fires the same
         notifyClosed → Hauptfenster mountet das Tile inline wieder
         (sobald der Viewer das Sidebar-Symbol erneut klickt). -->
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
      Ungültiger Stream-Link.
    </div>
  {/if}
</div>
