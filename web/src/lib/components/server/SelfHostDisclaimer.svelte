<!--
  SelfHostDisclaimer — Phase 4.3.

  Bei jedem App-Start sichtbar wenn der aktive Server NICHT Cloud ist UND
  der User den Disclaimer für genau diesen serverId noch nicht weggeklickt
  hat. localStorage-Key: `pulse.disclaimer_seen_<serverId>`.

  Mini-Toast/Banner unterhalb des UpdateBanners. Schließbar per "Verstanden".
-->
<script lang="ts">
  import ShieldAlertIcon from '@lucide/svelte/icons/shield-alert';
  import { Button } from '$lib/components/ui/button/index.js';
  import { activeServer } from '$lib/stores/active-server.svelte';
  import { m } from '$lib/paraglide/messages.js';

  let dismissed = $state<Record<string, boolean>>({});

  function seen(serverId: string): boolean {
    if (dismissed[serverId]) return true;
    if (typeof window === 'undefined') return true;
    return window.localStorage.getItem(`pulse.disclaimer_seen_${serverId}`) === '1';
  }

  function dismiss(serverId: string): void {
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(`pulse.disclaimer_seen_${serverId}`, '1');
    }
    dismissed = { ...dismissed, [serverId]: true };
  }

  let active = $derived(activeServer.current);
  let visible = $derived(!!active && !active.isCloud && !seen(active.id));
</script>

{#if visible && active}
  <div
    class="mx-3 mt-2 flex items-center gap-3 rounded-xl border border-amber-500/40 bg-amber-500/15 px-3 py-2 text-sm text-amber-100"
    data-testid="self-host-disclaimer-toast"
    role="note"
  >
    <ShieldAlertIcon class="size-4 shrink-0" />
    <span class="flex-1">
      {m.self_host_disclaimer_notice_before()} <strong>{active.label}</strong>{m.self_host_disclaimer_notice_after()}
    </span>
    <Button
      size="sm"
      variant="outline"
      onclick={() => dismiss(active.id)}
      data-testid="self-host-disclaimer-ack"
    >
      {m.self_host_disclaimer_ack()}
    </Button>
  </div>
{/if}
