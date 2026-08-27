<!--
  Der manuelle Weg: fertige `.env` holen, Compose-Datei dazu, Anleitung.

  Eigene Datei, seit der Einrichtung aufklappt statt als Dialog zu erscheinen
  (2026-08-27): der Inhalt zusammen wäre über der Größen-Policy gelandet, und
  „Schnellweg" und „von Hand" sind ohnehin zwei Entscheidungen, nicht eine.
-->
<script lang="ts">
  import { toast } from 'svelte-sonner';
  import { m } from '$lib/paraglide/messages.js';
  import { ApiError } from '$lib/api/client';
  import { instancesApi, type Instance } from '$lib/api/instances';
  import EnvReissuePanel from '../EnvReissuePanel.svelte';
  import ComposeDownloadLinks from '../ComposeDownloadLinks.svelte';
  import { Button } from '$lib/components/ui/button';
  import DownloadIcon from '@lucide/svelte/icons/download';
  import ExternalLinkIcon from '@lucide/svelte/icons/external-link';

  let { instance, base }: { instance: Instance; base: string } = $props();

  let envDownloading = $state(false);
  // 403 beim Env-Download = One-Shot verbraucht → Neu-Ausstellen anbieten.
  let envConsumed = $state(false);

  async function downloadEnv(reset = false) {
    if (envDownloading) return;
    envDownloading = true;
    try {
      await instancesApi.downloadEnvFile(instance.id, { reset });
      envConsumed = false;
      toast.success(m.instance_setup_manual_downloaded());
    } catch (e) {
      // NUR die One-Shot-Kollision wird zum Neu-Ausstellen-Zustand (kein Toast:
      // der erklärt zwar den Grund, verschwindet aber wieder und bietet keinen
      // Ausweg — analog zum Bootstrap-Token, BootstrapConsumedPanel).
      //
      // Die Route kennt drei verschiedene 403, und „jeder 403 heißt schon
      // heruntergeladen" war falsch: eine gesperrte Instanz und das
      // App-Host-Flag landeten in derselben Anzeige, die dann eine erledigte
      // Handlung behauptete und ein „neu ausstellen" anbot, das im selben 403
      // endet. Deshalb entscheidet der Code des Servers, nicht der Status.
      if (e instanceof ApiError && e.status === 403) {
        if (String(e.message).startsWith('already_provisioned')) envConsumed = true;
        else toast.error(m.instance_setup_env_blocked());
      } else {
        toast.error(m.instance_setup_error());
      }
    } finally {
      envDownloading = false;
    }
  }
</script>

<div class="border-border bg-bg-input/40 flex flex-col gap-2.5 rounded-xl border p-3">
  <p class="text-text-bright text-xs font-semibold tracking-wide uppercase">
    {m.instance_setup_manual_title()}
  </p>
  <p class="text-text-muted text-xs">{m.instance_setup_manual_desc()}</p>

  {#if envConsumed}
    <EnvReissuePanel busy={envDownloading} onreissue={() => void downloadEnv(true)} />
  {:else}
    <Button
      variant="outline"
      size="xs"
      class="w-fit"
      onclick={() => void downloadEnv()}
      disabled={envDownloading}
      data-testid="instance-setup-env-download"
    >
      <DownloadIcon class="size-4" />
      {envDownloading
        ? m.instance_setup_manual_downloading()
        : m.instance_setup_manual_download()}
    </Button>
    <p class="text-warning text-xs">{m.instance_setup_manual_download_warning()}</p>
  {/if}

  <ComposeDownloadLinks {base} />

  <p class="text-text-muted text-xs">{m.instance_setup_manual_steps()}</p>
  <a
    href="{base}/self-host/guide"
    target="_blank"
    rel="noopener noreferrer"
    class="text-primary border-primary/40 hover:bg-primary/10 flex w-fit items-center gap-2 rounded-md border px-3 py-2 text-xs font-semibold"
    data-testid="instance-setup-manual-link"
  >
    <ExternalLinkIcon class="size-3.5" />
    {m.instance_setup_manual_link()}
  </a>
</div>
