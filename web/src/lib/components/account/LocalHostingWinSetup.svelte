<script lang="ts">
  // Windows-Erststart-Assistent (Phase 'needs-windows-setup'): WSL2 fehlt für
  // podman machine. Ein Knopf löst die Installation mit Admin-Abfrage aus
  // (host.setupWindows → wsl --install), danach Neustart-Hinweis + Weiter.
  // Als eigene Komponente ausgelagert (LocalHosting-Größen-Cap).
  import { hostStore } from '$lib/host/hostStore.svelte';
  import { Button } from '$lib/components/ui/button/index.js';
  import * as Alert from '$lib/components/ui/alert/index.js';
  import { m } from '$lib/paraglide/messages.js';
</script>

<Alert.Root data-testid="local-host-win-setup">
  <Alert.Title>{m.local_host_win_setup_title()}</Alert.Title>
  <Alert.Description>
    {#if hostStore.winSetupState === 'done'}
      <p>{m.local_host_win_setup_done()}</p>
    {:else if hostStore.winSetupState === 'failed'}
      <p>{m.local_host_win_setup_failed()}</p>
    {:else}
      <p>{m.local_host_win_setup_body()}</p>
    {/if}
  </Alert.Description>
</Alert.Root>

{#if hostStore.winSetupState === 'running'}
  <p class="text-text-muted text-sm" data-testid="local-host-win-running">
    {m.local_host_win_setup_running()}
  </p>
{:else if hostStore.winSetupState === 'done'}
  <div>
    <Button size="sm" onclick={() => hostStore.start()} data-testid="local-host-win-continue">
      {m.local_host_win_setup_continue()}
    </Button>
  </div>
{:else}
  <div>
    <Button size="sm" onclick={() => hostStore.windowsSetup()} data-testid="local-host-win-install">
      {m.local_host_win_setup_install()}
    </Button>
  </div>
{/if}
