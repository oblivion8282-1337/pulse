<script lang="ts">
  import { onMount } from 'svelte';
  import { isElectron } from '$lib/platform/runtime';
  import { hostStore } from '$lib/host/hostStore.svelte';
  import { Button } from '$lib/components/ui/button/index.js';
  import * as Alert from '$lib/components/ui/alert/index.js';
  import StatusDot from '$lib/components/ui/StatusDot.svelte';
  import { m } from '$lib/paraglide/messages.js';
  import { toast } from 'svelte-sonner';

  const running = $derived(
    ['checking-network', 'opening-door', 'preparing', 'going-live'].includes(hostStore.phase)
  );

  const phaseLine = $derived.by(() => {
    switch (hostStore.phase) {
      case 'checking-network': return m.local_host_phase_checking_network();
      case 'opening-door': return m.local_host_phase_opening_door();
      case 'preparing': return m.local_host_phase_preparing();
      case 'going-live': return m.local_host_phase_going_live();
      default: return '';
    }
  });

  onMount(() => { hostStore.init(); });

  async function copyLink() {
    if (hostStore.detail?.relayUrl) {
      await navigator.clipboard.writeText(hostStore.detail.relayUrl);
      toast.success(m.local_host_link_copied());
    }
  }
</script>

{#if isElectron()}
  <section class="flex flex-col gap-5" data-testid="local-hosting-section">
    <div class="flex flex-col gap-1">
      <h3 class="text-text-bright text-sm font-semibold">{m.local_host_title()}</h3>
      <p class="text-text-muted text-xs">{m.local_host_subtitle()}</p>
    </div>

    {#if hostStore.phase === 'idle'}
      <p class="text-text-muted text-sm">{m.local_host_idle_body()}</p>
      <div>
        <Button onclick={() => hostStore.start()} data-testid="local-host-start">
          {m.local_host_start()}
        </Button>
      </div>

    {:else if running}
      <div class="flex items-center gap-3" data-testid="local-host-progress">
        <StatusDot status="idle" class="size-3 animate-pulse" />
        <span class="text-text-bright text-sm">{phaseLine}</span>
      </div>
      <div>
        <Button variant="ghost" size="sm" onclick={() => hostStore.stop()}>
          {m.local_host_cancel()}
        </Button>
      </div>

    {:else if hostStore.phase === 'live'}
      <div class="flex items-center gap-3" data-testid="local-host-live">
        <StatusDot status="online" class="size-3" />
        <span class="text-text-bright text-sm font-medium">{m.local_host_live_title()}</span>
      </div>
      <p class="text-text-muted text-sm">{m.local_host_live_body()}</p>
      {#if hostStore.detail?.relayUrl}
        <div class="bg-bg-input flex items-center gap-2 rounded-md px-3 py-2">
          <span class="text-text-bright truncate text-sm" data-testid="local-host-url">
            {hostStore.detail.relayUrl}
          </span>
          <Button variant="outline" size="xs" onclick={copyLink}>
            {m.local_host_copy_link()}
          </Button>
        </div>
      {/if}
      <div>
        <Button variant="ghost" size="sm" onclick={() => hostStore.stop()}>
          {m.local_host_stop()}
        </Button>
      </div>

    {:else if hostStore.phase === 'needs-your-help'}
      <Alert.Root data-testid="local-host-help">
        <Alert.Title>{m.local_host_help_title()}</Alert.Title>
        <Alert.Description>
          <p>{m.local_host_help_body()}</p>
          <ol class="mt-2 list-decimal pl-4 text-sm">
            <li>{m.local_host_help_step1()}</li>
            <li>{m.local_host_help_step2()}</li>
            <li>{m.local_host_help_step3()}</li>
          </ol>
        </Alert.Description>
      </Alert.Root>
      <div>
        <Button size="sm" onclick={() => hostStore.start()}>
          {m.local_host_recheck()}
        </Button>
      </div>

    {:else if hostStore.phase === 'not-possible-here'}
      <Alert.Root data-testid="local-host-cgnat">
        <Alert.Title>{m.local_host_cgnat_title()}</Alert.Title>
        <Alert.Description>
          <p>{m.local_host_cgnat_body()}</p>
          <p class="mt-2">{m.local_host_cgnat_alt()}</p>
        </Alert.Description>
      </Alert.Root>

    {:else if hostStore.phase === 'something-paused'}
      <Alert.Root variant="destructive" data-testid="local-host-paused">
        <Alert.Title>{m.local_host_paused_title()}</Alert.Title>
        <Alert.Description>{m.local_host_paused_body()}</Alert.Description>
      </Alert.Root>
      <div>
        <Button size="sm" onclick={() => hostStore.start()}>
          {m.local_host_retry()}
        </Button>
      </div>
    {/if}
  </section>
{/if}
