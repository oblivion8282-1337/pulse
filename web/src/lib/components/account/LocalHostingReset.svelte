<script lang="ts">
  // „Zugang übertragen"-Karte (hostStore.pairConsumed): Bootstrap wurde schon
  // einmal eingelöst (anderes Gerät / Neuinstallation) → bewusster Reset-Pfad
  // mit zweistufiger Bestätigung (Mint mit reset=true rotiert die Credentials).
  // Als eigene Komponente ausgelagert (LocalHosting-Größen-Cap).
  import { hostStore } from '$lib/host/hostStore.svelte';
  import { Button } from '$lib/components/ui/button/index.js';
  import { m } from '$lib/paraglide/messages.js';

  let { chosenId = '' }: { chosenId?: string } = $props();
  let confirmReset = $state(false);

  async function doReset() {
    confirmReset = false;
    await hostStore.start(chosenId || undefined, { reset: true });
  }
</script>

<div class="flex flex-col gap-2" data-testid="local-host-consumed">
  <p class="text-text-bright text-sm font-medium">{m.local_host_consumed_title()}</p>
  <p class="text-text-muted text-sm">{m.local_host_consumed_body()}</p>
  {#if confirmReset}
    <p class="text-text-muted text-sm">{m.local_host_reset_confirm_body()}</p>
    <div class="flex gap-2">
      <Button size="sm" onclick={doReset} data-testid="local-host-reset-confirm">
        {m.local_host_reset_confirm_yes()}
      </Button>
      <Button variant="ghost" size="sm" onclick={() => (confirmReset = false)}>
        {m.local_host_cancel()}
      </Button>
    </div>
  {:else}
    <div>
      <Button size="sm" onclick={() => (confirmReset = true)} data-testid="local-host-reset">
        {m.local_host_reset_button()}
      </Button>
    </div>
  {/if}
</div>
