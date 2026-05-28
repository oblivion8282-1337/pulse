<!--
  Liste der eigenen Self-Host-Instanzen im Einstellungs-Dialog.
  Endpoint: GET /me/instances + GET /me/instances/{id}/docker-compose-snippet
  Cookie-Auth via instancesApi.

  Hinweis: client_secret wird hier NICHT angezeigt (nur einmalig bei Approval).
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { toast } from 'svelte-sonner';
  import { instancesApi, type Instance } from '$lib/api/instances';
  import * as Dialog from '$lib/components/ui/dialog/index.js';
  import DownloadIcon from '@lucide/svelte/icons/download';
  import BookOpenIcon from '@lucide/svelte/icons/book-open';
  import ServerIcon from '@lucide/svelte/icons/server';

  let instances = $state<Instance[]>([]);
  let loading = $state(true);
  let downloading = $state<string | null>(null);
  let guideOpen = $state(false);
  let guideInstance = $state<Instance | null>(null);

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
      toast.error('Download fehlgeschlagen', {
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
      <h3 class="text-text-bright text-sm font-semibold">Meine Instanzen</h3>
      <p class="text-text-muted text-xs mt-0.5">
        Deine freigeschalteten Self-Host-Server.
      </p>
    </div>
  </div>

  <!-- Secret-Hinweis -->
  <div class="border-border bg-amber-500/10 flex gap-2 rounded-xl border border-amber-500/30 p-3">
    <p class="text-amber-200 text-xs leading-relaxed">
      Dein Client-Secret wurde dir einmalig nach Genehmigung angezeigt.
      Falls du es verloren hast, bitte einen Admin um eine Secret-Rotation.
    </p>
  </div>

  {#if loading}
    <p class="text-text-muted text-sm">Lade…</p>
  {:else if instances.length === 0}
    <p class="text-text-muted text-sm">Noch keine Instanzen — ein genehmigter Antrag wird hier erscheinen.</p>
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
              {inst.status === 'active' ? 'Aktiv' : 'Gesperrt'}
            </span>
          </div>
          <div class="flex gap-2 mt-1">
            <button
              type="button"
              onclick={() => void download(inst)}
              disabled={downloading === inst.id}
              class="flex items-center gap-1.5 rounded-lg border border-border bg-bg-hover px-3 py-1.5 text-xs text-text-base hover:text-text-bright transition-colors disabled:opacity-60"
            >
              <DownloadIcon class="size-3.5" />
              {downloading === inst.id ? 'Lädt…' : '.env-Snippet'}
            </button>
            <button
              type="button"
              onclick={() => openGuide(inst)}
              class="flex items-center gap-1.5 rounded-lg border border-border bg-bg-hover px-3 py-1.5 text-xs text-text-base hover:text-text-bright transition-colors"
            >
              <BookOpenIcon class="size-3.5" />
              Anleitung
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
        <Dialog.Title>Self-Host Setup</Dialog.Title>
        <Dialog.Description>
          {guideInstance?.hostname ?? ''}
        </Dialog.Description>
      </Dialog.Header>
      <div class="flex flex-col gap-3 text-sm">
        <ol class="text-text-base flex flex-col gap-2 list-decimal list-inside">
          <li>Lade das <strong class="text-text-bright">.env-Snippet</strong> herunter und trag dein Client-Secret ein.</li>
          <li>Kopiere <code class="bg-bg-input rounded px-1 text-xs">infra/prod/</code> aus dem Pulse-Repo auf deinen Server.</li>
          <li>Führe <code class="bg-bg-input rounded px-1 text-xs">docker compose up -d</code> aus.</li>
          <li>Konfiguriere Caddy/nginx so, dass es auf <strong class="text-text-bright">{guideInstance?.hostname ?? 'deine-domain.tld'}</strong> zeigt.</li>
          <li>Setze in der Pulse-Web-App <code class="bg-bg-input rounded px-1 text-xs">PULSE_CLOUD_ORIGIN=https://howispulse.com</code>.</li>
        </ol>
        <p class="text-text-muted text-xs">
          Worker-IDs (Chat/Voice/Media):
          {guideInstance?.worker_id_chat}/{guideInstance?.worker_id_voice}/{guideInstance?.worker_id_media}
          — eingetragen im .env-Snippet.
        </p>
      </div>
      <div class="flex justify-end pt-2">
        <button
          type="button"
          onclick={() => (guideOpen = false)}
          class="bg-primary hover:bg-primary/90 text-white rounded-xl px-4 py-2 text-sm font-medium"
        >
          Schließen
        </button>
      </div>
    </Dialog.Content>
  </Dialog.Portal>
</Dialog.Root>
