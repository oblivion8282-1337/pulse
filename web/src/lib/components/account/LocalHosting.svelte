<script lang="ts">
  import { onMount } from 'svelte';
  import { isElectron } from '$lib/platform/runtime';
  import { hostStore } from '$lib/host/hostStore.svelte';
  import { Button } from '$lib/components/ui/button/index.js';
  import * as Alert from '$lib/components/ui/alert/index.js';
  import StatusDot from '$lib/components/ui/StatusDot.svelte';
  import { m } from '$lib/paraglide/messages.js';
  import { toast } from 'svelte-sonner';
  import { auth } from '$lib/stores/auth.svelte';
  import { myAppHostApplications } from '$lib/stores/myAppHostApplications.svelte';
  import AppHostApplicationDialog from './AppHostApplicationDialog.svelte';

  // Neuesten Antrag ableiten, damit wir pending/rejected-Zustände anzeigen
  // können, ohne den User auf das Admin-Panel vertrösten zu müssen.
  const myPendingApp = $derived(
    myAppHostApplications.applications.find((a) => a.status === 'pending') ?? null
  );
  const myLastRejected = $derived(
    myAppHostApplications.applications.find((a) => a.status === 'rejected') ?? null
  );

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

  let chosenId = $state(hostStore.instances[0]?.id ?? '');
  let anchorFired = $state(false);

  $effect(() => {
    if (hostStore.phase === 'live' && !anchorFired) {
      anchorFired = true;
      void hostStore.anchorLive().then(() => {
        toast.success(m.local_host_server_added());
      });
    }
    if (hostStore.phase !== 'live') anchorFired = false;
  });

  onMount(() => {
    hostStore.init();
    // Eigene App-Hosting-Anträge laden, damit pending/rejected-Cases live
    // sichtbar sind (sonst nur Locked-Card ohne Antrags-Status).
    void myAppHostApplications.reload();
    myAppHostApplications.start();
  });

  async function copyLink() {
    if (hostStore.detail?.relayUrl) {
      try {
        await navigator.clipboard.writeText(hostStore.detail.relayUrl);
        toast.success(m.local_host_link_copied());
      } catch {
        toast.error(m.local_host_copy_failed());
      }
    }
  }

  async function startWithChoice() {
    await hostStore.start(chosenId || undefined);
  }
</script>

{#if isElectron()}
  <section class="flex flex-col gap-5" data-testid="local-hosting-section">
    {#if hostStore.phase === 'idle'}
      {#if auth.user?.self_host_enabled === false}
        <div class="flex flex-col gap-3" data-testid="local-host-locked">
          {#if myPendingApp}
            <p class="text-text-bright text-sm font-medium">{m.local_host_locked_pending_title()}</p>
            <p class="text-text-muted text-sm">{m.local_host_locked_pending_body()}</p>
          {:else if myLastRejected}
            <p class="text-text-bright text-sm font-medium">{m.local_host_locked_rejected_title()}</p>
            <p class="text-text-muted text-sm">
              {m.local_host_locked_rejected_body({ reason: myLastRejected.rejection_reason ?? '' })}
            </p>
            <div><AppHostApplicationDialog /></div>
          {:else}
            <p class="text-text-bright text-sm font-medium">{m.local_host_locked_title()}</p>
            <p class="text-text-muted text-sm">{m.local_host_locked_body()}</p>
            <div><AppHostApplicationDialog /></div>
          {/if}
        </div>
      {:else if hostStore.instances.length === 0 && !hostStore.paired}
        <div class="flex flex-col gap-2" data-testid="local-host-no-instance">
          <p class="text-text-bright text-sm font-medium">{m.local_host_no_instance_title()}</p>
          <p class="text-text-muted text-sm">{m.local_host_no_instance_body()}</p>
        </div>

      {:else if hostStore.needsChoice}
        <div class="flex flex-col gap-3">
          <label class="flex flex-col gap-1">
            <span class="text-text-muted text-xs">{m.local_host_choose_instance()}</span>
            <select
              bind:value={chosenId}
              class="bg-bg-input text-text-bright rounded-md px-3 py-2 text-sm"
            >
              {#each hostStore.instances as inst (inst.id)}
                <option value={inst.id}>{inst.hostname}</option>
              {/each}
            </select>
          </label>
          <div>
            <Button onclick={startWithChoice} data-testid="local-host-choose">
              {m.local_host_start()}
            </Button>
          </div>
        </div>

      {:else}
        <p class="text-text-muted text-sm">{m.local_host_idle_body()}</p>
        <div>
          <Button onclick={() => hostStore.start()} data-testid="local-host-start">
            {m.local_host_start()}
          </Button>
        </div>
      {/if}

      {#if hostStore.pairError}
        <p class="text-text-muted text-sm" data-testid="local-host-pair-error">
          {m.local_host_pair_failed()}
        </p>
      {/if}

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
      <Alert.Root data-testid="local-host-paused">
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
