<!--
  Liste der eigenen Self-Host-Instanzen im Einstellungs-Dialog.
  Endpoint: GET /me/instances + GET /me/instances/{id}/docker-compose-snippet
  Cookie-Auth via instancesApi.

  Hinweis: client_secret wird hier NICHT angezeigt (nur einmalig bei Approval).
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { toast } from 'svelte-sonner';
  import { m } from '$lib/paraglide/messages.js';
  import { instancesApi, type Instance } from '$lib/api/instances';
  import * as Dialog from '$lib/components/ui/dialog/index.js';
  import InstanceSetupDialog from './InstanceSetupDialog.svelte';
  import DownloadIcon from '@lucide/svelte/icons/download';
  import BookOpenIcon from '@lucide/svelte/icons/book-open';
  import ServerIcon from '@lucide/svelte/icons/server';
  import TerminalIcon from '@lucide/svelte/icons/terminal';

  let instances = $state<Instance[]>([]);
  let loading = $state(true);
  let downloading = $state<string | null>(null);
  let guideOpen = $state(false);
  let guideInstance = $state<Instance | null>(null);
  let setupOpen = $state(false);
  let setupInstance = $state<Instance | null>(null);

  function openSetup(inst: Instance) {
    setupInstance = inst;
    setupOpen = true;
  }

  onMount(async () => {
    try {
      instances = await instancesApi.listMyInstances();
    } catch {
      // Nicht kritisch
    } finally {
      loading = false;
    }
  });

  async function download(inst: Instance) {
    downloading = inst.id;
    try {
      await instancesApi.downloadComposeSnippet(inst.id);
    } catch (e) {
      toast.error(m.my_instances_download_failed(), {
        description: e instanceof Error ? e.message : String(e)
      });
    } finally {
      downloading = null;
    }
  }

  function openGuide(inst: Instance) {
    guideInstance = inst;
    guideOpen = true;
  }

  function statusClass(s: string): string {
    return s === 'active'
      ? 'bg-emerald-500/20 text-emerald-300'
      : 'bg-red-500/20 text-red-300';
  }
</script>

<div class="flex flex-col gap-5" data-testid="my-instances">
  <div class="flex items-start gap-3">
    <span class="bg-bg-input text-text-muted flex size-9 shrink-0 items-center justify-center rounded-full">
      <ServerIcon class="size-5" />
    </span>
    <div>
      <h3 class="text-text-bright text-sm font-semibold">{m.my_instances_title()}</h3>
      <p class="text-text-muted text-xs mt-0.5">
        {m.my_instances_subtitle()}
      </p>
    </div>
  </div>

  <!-- Secret-Hinweis -->
  <div class="border-border bg-amber-500/10 flex gap-2 rounded-xl border border-amber-500/30 p-3">
    <p class="text-amber-200 text-xs leading-relaxed">
      {m.my_instances_secret_hint()}
    </p>
  </div>

  {#if loading}
    <p class="text-text-muted text-sm">{m.my_instances_loading()}</p>
  {:else if instances.length === 0}
    <p class="text-text-muted text-sm">{m.my_instances_empty()}</p>
  {:else}
    <div class="flex flex-col gap-2">
      {#each instances as inst (inst.id)}
        <div class="border-border bg-bg-input/30 rounded-xl border p-3 flex flex-col gap-2"
             data-testid="instance-row-{inst.id}">
          <div class="flex items-start justify-between gap-3">
            <div class="min-w-0">
              <p class="text-text-bright text-sm font-medium truncate">{inst.hostname}</p>
              <p class="text-text-muted text-xs mt-0.5">
                ID: {inst.client_id.slice(0, 12)}… ·
                Workers: {inst.worker_id_chat}/{inst.worker_id_voice}/{inst.worker_id_media} ·
                {new Date(inst.registered_at).toLocaleDateString('de-DE')}
              </p>
            </div>
            <span class="rounded-full px-2 py-0.5 text-xs font-medium shrink-0 {statusClass(inst.status)}">
              {inst.status === 'active' ? m.my_instances_status_active() : m.my_instances_status_suspended()}
            </span>
          </div>
          <div class="flex flex-wrap gap-2 mt-1">
            <button
              type="button"
              onclick={() => openSetup(inst)}
              class="flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-white hover:bg-primary/90 transition-colors"
              data-testid="instance-setup-btn-{inst.id}"
            >
              <TerminalIcon class="size-3.5" />
              {m.instance_setup_button()}
            </button>
            <button
              type="button"
              onclick={() => void download(inst)}
              disabled={downloading === inst.id}
              class="flex items-center gap-1.5 rounded-lg border border-border bg-bg-hover px-3 py-1.5 text-xs text-text-base hover:text-text-bright transition-colors disabled:opacity-60"
            >
              <DownloadIcon class="size-3.5" />
              {downloading === inst.id ? m.my_instances_downloading() : '.env-Snippet'}
            </button>
            <button
              type="button"
              onclick={() => openGuide(inst)}
              class="flex items-center gap-1.5 rounded-lg border border-border bg-bg-hover px-3 py-1.5 text-xs text-text-base hover:text-text-bright transition-colors"
            >
              <BookOpenIcon class="size-3.5" />
              {m.my_instances_guide_button()}
            </button>
          </div>
        </div>
      {/each}
    </div>
  {/if}
</div>

<!-- Setup-Anleitung Modal -->
<Dialog.Root bind:open={guideOpen}>
  <Dialog.Portal>
    <Dialog.Overlay />
    <Dialog.Content class="max-w-lg" data-testid="instance-guide-dialog">
      <Dialog.Header>
        <Dialog.Title>{m.my_instances_guide_title()}</Dialog.Title>
        <Dialog.Description>
          {guideInstance?.hostname ?? ''}
        </Dialog.Description>
      </Dialog.Header>
      <div class="flex flex-col gap-3 text-sm">
        <ol class="text-text-base flex flex-col gap-2 list-decimal list-inside">
          <li>{m.my_instances_guide_step1_before()} <strong class="text-text-bright">.env-Snippet</strong> {m.my_instances_guide_step1_after()}</li>
          <li>{m.my_instances_guide_step2_before()} <code class="bg-bg-input rounded px-1 text-xs">infra/prod/</code> {m.my_instances_guide_step2_after()}</li>
          <li>{m.my_instances_guide_step3_before()} <code class="bg-bg-input rounded px-1 text-xs">docker compose up -d</code> {m.my_instances_guide_step3_after()}</li>
          <li>{m.my_instances_guide_step4_before()} <strong class="text-text-bright">{guideInstance?.hostname ?? 'deine-domain.tld'}</strong> {m.my_instances_guide_step4_after()}</li>
          <li>{m.my_instances_guide_step5_before()} <code class="bg-bg-input rounded px-1 text-xs">PULSE_CLOUD_ORIGIN=https://howispulse.com</code>{m.my_instances_guide_step5_after()}</li>
        </ol>
        <p class="text-text-muted text-xs">
          {m.my_instances_guide_worker_ids()}
          {guideInstance?.worker_id_chat}/{guideInstance?.worker_id_voice}/{guideInstance?.worker_id_media}
          {m.my_instances_guide_worker_ids_suffix()}
        </p>
      </div>
      <div class="flex justify-end pt-2">
        <button
          type="button"
          onclick={() => (guideOpen = false)}
          class="bg-primary hover:bg-primary/90 text-white rounded-xl px-4 py-2 text-sm font-medium"
        >
          {m.my_instances_guide_close()}
        </button>
      </div>
    </Dialog.Content>
  </Dialog.Portal>
</Dialog.Root>

<!-- Ein-Befehl-Installer -->
<InstanceSetupDialog bind:open={setupOpen} instance={setupInstance} />
