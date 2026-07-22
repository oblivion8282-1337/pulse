<!--
  RemoteControllerViewer — Vollbild-Overlay auf der Controller-Seite: zeigt den
  Host-Bildschirm (`remoteController.stream`) und koppelt die Input-Capture
  (Scheibe 4) ans `<video>`. Global gemountet; sichtbar, solange die eigene
  Rolle Controller ist und die Session verbindet/läuft.

  Zwei Steuer-Modi (s. Wire-Spec): im Absolut-Modus ist das Bild direkt
  bedienbar (Zeiger bewegen = Host-Cursor), „Maus einfangen" schaltet für Spiele
  auf Pointer-Lock (relativ) um.
-->
<script lang="ts">
  import { Button } from '$lib/components/ui/button/index.js';
  import MousePointerIcon from '@lucide/svelte/icons/mouse-pointer-click';
  import XIcon from '@lucide/svelte/icons/x';
  import { remoteSession } from '$lib/remote/session.svelte';
  import { remoteController } from '$lib/remote/controller.svelte';
  import { remoteInput } from '$lib/remote/capture.svelte';
  import { userCache } from '$lib/stores/users.svelte';
  import { m } from '$lib/paraglide/messages.js';

  let show = $derived(
    remoteSession.role === 'controller' &&
      (remoteSession.phase === 'connecting' || remoteSession.phase === 'active'),
  );
  let peerName = $derived(userCache.displayName(remoteSession.peerUserId ?? ''));
  let connecting = $derived(remoteSession.phase === 'connecting' || !remoteController.stream);
  let videoEl = $state<HTMLVideoElement | null>(null);

  // Stream ans <video> hängen und die Input-Capture ankoppeln (löst beim Unmount).
  $effect(() => {
    const el = videoEl;
    if (!el) return;
    el.srcObject = remoteController.stream;
    remoteInput.attach(el);
    return () => remoteInput.detach();
  });
</script>

{#if show}
  <div class="fixed inset-0 z-[55] flex flex-col bg-black/95" data-testid="remote-viewer">
    <div class="flex items-center gap-3 px-4 py-2.5">
      <span class="flex items-center gap-2 text-sm font-medium text-white">
        <span
          class="size-2 rounded-full {connecting ? 'bg-amber-400' : 'bg-emerald-400'}"
          class:animate-pulse={connecting}
        ></span>
        {connecting ? m.remote_viewer_connecting() : m.remote_viewer_controlling({ user: peerName })}
      </span>
      <span class="ml-auto"></span>
      {#if !connecting && !remoteInput.pointerLocked}
        <Button
          size="sm"
          variant="secondary"
          onclick={() => remoteInput.requestPointerLock()}
          data-testid="remote-viewer-capture"
        >
          <MousePointerIcon class="size-4" />
          {m.remote_viewer_capture_mouse()}
        </Button>
      {/if}
      <Button
        size="sm"
        variant="destructive"
        onclick={() => remoteSession.end()}
        data-testid="remote-viewer-release"
      >
        <XIcon class="size-4" />
        {m.remote_viewer_release()}
      </Button>
    </div>

    <div class="relative min-h-0 flex-1">
      <!-- svelte-ignore a11y_media_has_caption -->
      <video
        bind:this={videoEl}
        autoplay
        playsinline
        tabindex="0"
        class="h-full w-full object-contain outline-none"
        data-testid="remote-viewer-video"
      ></video>

      {#if connecting}
        <div class="absolute inset-0 grid place-items-center">
          <span
            class="rounded-lg border border-white/15 bg-black/70 px-4 py-2 text-sm text-white/90"
          >
            {m.remote_viewer_connecting()}
          </span>
        </div>
      {:else if !remoteInput.pointerLocked}
        <div class="pointer-events-none absolute inset-x-0 bottom-6 grid place-items-center">
          <span
            class="rounded-lg border border-white/15 bg-black/60 px-3.5 py-1.5 text-xs text-white/80"
          >
            {m.remote_viewer_take_control()}
          </span>
        </div>
      {/if}
    </div>
  </div>
{/if}
