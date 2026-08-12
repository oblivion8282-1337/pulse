<!--
  RemoteHostBanner — dauerhaftes, bewusst warnfarbenes Banner, solange der
  eigene Bildschirm ferngesteuert wird (Host-Seite). Global gemountet. „Jemand
  steuert meinen Rechner" darf man nie übersehen — deshalb oben zentriert,
  Amber statt Akzentblau, und ein jederzeit klickbares „Beenden".
-->
<script lang="ts">
  import { Button } from '$lib/components/ui/button/index.js';
  import MousePointerIcon from '@lucide/svelte/icons/mouse-pointer-click';
  import XIcon from '@lucide/svelte/icons/x';
  import { remoteSession } from '$lib/remote/session.svelte';
  import { userCache } from '$lib/stores/users.svelte';
  import { m } from '$lib/paraglide/messages.js';

  // Nur für den Host und nur, solange die Session wirklich läuft.
  let show = $derived(remoteSession.role === 'host' && remoteSession.phase === 'active');
  let peerName = $derived(userCache.displayName(remoteSession.peerUserId ?? ''));
</script>

{#if show}
  <div
    class="fixed left-1/2 top-3 z-[60] flex -translate-x-1/2 items-center gap-3 rounded-xl border
      border-amber-500/40 bg-amber-500/15 px-4 py-2.5 shadow-lg backdrop-blur"
    role="status"
    data-testid="remote-host-banner"
  >
    <span class="grid size-8 place-items-center rounded-lg bg-amber-500/25 text-amber-500">
      <MousePointerIcon class="size-4" />
    </span>
    <span class="min-w-0">
      <span class="text-text-bright block text-sm font-semibold">
        {m.remote_host_banner_title({ user: peerName })}
      </span>
      <span class="text-text-base block text-xs">{m.remote_host_banner_since()}</span>
    </span>
    <Button
      size="sm"
      variant="destructive"
      class="ml-1"
      onclick={() => remoteSession.end()}
      data-testid="remote-host-banner-stop"
    >
      <XIcon class="size-4" />
      {m.remote_host_banner_stop()}
    </Button>
  </div>
{/if}
