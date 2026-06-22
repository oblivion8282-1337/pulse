<!--
  Ein-Befehl-Installer-Dialog für eine Self-Host-Instanz.
  Mintet beim Öffnen einen One-Time-Bootstrap-Token (POST /me/instances/{id}/
  bootstrap-token) und zeigt den fertigen `curl … | bash`-Befehl mit Kopieren,
  Ablauf-Countdown und Neu-generieren. Der Token wird beim Einlösen auf dem
  Server verbraucht; das Pairing-Secret rotiert dabei serverseitig.
-->
<script lang="ts">
  import { untrack } from 'svelte';
  import { toast } from 'svelte-sonner';
  import { m } from '$lib/paraglide/messages.js';
  import { instancesApi, type Instance } from '$lib/api/instances';
  import * as Dialog from '$lib/components/ui/dialog/index.js';
  import CopyIcon from '@lucide/svelte/icons/copy';
  import CheckIcon from '@lucide/svelte/icons/check';
  import RefreshCwIcon from '@lucide/svelte/icons/refresh-cw';
  import DownloadIcon from '@lucide/svelte/icons/download';
  import ExternalLinkIcon from '@lucide/svelte/icons/external-link';

  let { open = $bindable(false), instance }: { open?: boolean; instance: Instance | null } =
    $props();

  let token = $state<string | null>(null);
  let expiresAtMs = $state(0);
  let loading = $state(false);
  let error = $state(false);
  let copied = $state(false);
  let aiCopied = $state(false);
  let showExplain = $state(false);
  let envDownloading = $state(false);
  let nowMs = $state(0);
  let ticker: ReturnType<typeof setInterval> | null = null;
  let mintGen = 0;

  let installBase = $derived(
    typeof location !== 'undefined' ? location.origin : 'https://howispulse.com'
  );
  // Env-Form statt argv (`bash -s -- <token>`): Argumente sind während der
  // Script-Laufzeit für jeden lokalen User in `ps` sichtbar, Env-Variablen
  // nur für Owner/Root. Das Script liest beides (install.sh: PULSE_BOOTSTRAP_TOKEN).
  let command = $derived(
    token ? `curl -fsSL ${installBase}/install | PULSE_BOOTSTRAP_TOKEN=${token} bash` : ''
  );
  // Fertiger Prompt für KI-Assistenten: Referenz-URL + personalisierter
  // Befehl in einem. Die Referenz (/install/guide) beschreibt Installer,
  // Architektur und Troubleshooting — damit kann eine KI bei Fehlern
  // (Proxy/DNS/Ports) gezielt helfen statt zu raten.
  let aiPrompt = $derived(
    command
      ? m.instance_setup_ai_prompt({ guideUrl: `${installBase}/install/guide`, command })
      : ''
  );
  let remainingMs = $derived(Math.max(0, expiresAtMs - nowMs));
  let expired = $derived(token !== null && expiresAtMs > 0 && remainingMs <= 0);
  let countdown = $derived(formatRemaining(remainingMs));

  function formatRemaining(ms: number): string {
    const total = Math.floor(ms / 1000);
    const mm = Math.floor(total / 60);
    const ss = total % 60;
    return `${mm}:${ss.toString().padStart(2, '0')}`;
  }

  async function mint() {
    if (!instance || loading) return;
    loading = true;
    error = false;
    // Generations-Guard: ein mint(), das während des Awaits durch reset()
    // (Dialog geschlossen / andere Instanz) überholt wurde, darf seinen Token
    // NICHT mehr schreiben — sonst zeigt der wieder-geöffnete Dialog den
    // Bootstrap-Token der vorigen Instanz (falsche Credential).
    const gen = ++mintGen;
    try {
      const res = await instancesApi.mintBootstrapToken(instance.id);
      if (gen !== mintGen) return;
      token = res.token;
      expiresAtMs = new Date(res.expires_at).getTime();
      nowMs = Date.now();
    } catch {
      if (gen !== mintGen) return;
      error = true;
      token = null;
    } finally {
      if (gen === mintGen) loading = false;
    }
  }

  async function copy() {
    if (!command) return;
    try {
      await navigator.clipboard.writeText(command);
      copied = true;
      setTimeout(() => (copied = false), 1500);
    } catch {
      toast.error(m.instance_setup_error());
    }
  }

  async function downloadEnv() {
    if (!instance || envDownloading) return;
    envDownloading = true;
    try {
      await instancesApi.downloadEnvFile(instance.id);
      toast.success(m.instance_setup_manual_downloaded());
    } catch {
      toast.error(m.instance_setup_error());
    } finally {
      envDownloading = false;
    }
  }

  async function copyAiPrompt() {
    if (!aiPrompt) return;
    try {
      await navigator.clipboard.writeText(aiPrompt);
      aiCopied = true;
      setTimeout(() => (aiCopied = false), 1500);
    } catch {
      toast.error(m.instance_setup_error());
    }
  }

  function startTicker() {
    if (ticker === null) ticker = setInterval(() => (nowMs = Date.now()), 1000);
  }
  function stopTicker() {
    if (ticker !== null) {
      clearInterval(ticker);
      ticker = null;
    }
  }
  function reset() {
    mintGen++; // jeden noch laufenden mint() invalidieren
    token = null;
    expiresAtMs = 0;
    error = false;
    loading = false;
    showExplain = false;
    stopTicker();
  }

  // Beim Öffnen einmal minten + Ticker starten; beim Schließen alles zurücksetzen.
  $effect(() => {
    const isOpen = open;
    const inst = instance;
    untrack(() => {
      if (isOpen && inst) {
        void mint();
        startTicker();
      } else {
        reset();
      }
    });
    return stopTicker;
  });
</script>

<Dialog.Root bind:open>
  <Dialog.Portal>
    <Dialog.Overlay />
    <Dialog.Content class="max-w-xl" data-testid="instance-setup-dialog">
      <Dialog.Header>
        <Dialog.Title>{m.instance_setup_title()}</Dialog.Title>
        <Dialog.Description>{instance?.hostname ?? ''}</Dialog.Description>
      </Dialog.Header>

      <div class="flex flex-col gap-4 text-sm">
        <p class="text-text-base">{m.instance_setup_intro()}</p>

        <p class="text-text-bright text-xs font-semibold tracking-wide uppercase">
          {m.instance_setup_quick_title()}
        </p>

        {#if loading && !token}
          <p class="text-text-muted">{m.instance_setup_loading()}</p>
        {:else if error}
          <div class="flex items-center justify-between gap-3 rounded-xl border border-red-500/30 bg-red-500/10 p-3">
            <p class="text-red-300 text-xs">{m.instance_setup_error()}</p>
            <button
              type="button"
              onclick={() => void mint()}
              class="flex items-center gap-1.5 rounded-lg border border-border bg-bg-hover px-3 py-1.5 text-xs"
            >
              <RefreshCwIcon class="size-3.5" />
              {m.instance_setup_regenerate()}
            </button>
          </div>
        {:else if token}
          <!-- Befehl -->
          <div class="flex flex-col gap-2">
            <div class="bg-bg-input border-border flex items-start gap-2 rounded-xl border p-3">
              <code
                class="text-text-bright min-w-0 flex-1 break-all font-mono text-xs leading-relaxed {expired
                  ? 'opacity-40'
                  : ''}"
                data-testid="instance-setup-command">{command}</code
              >
              <button
                type="button"
                onclick={copy}
                disabled={expired}
                aria-label={m.instance_setup_copy()}
                class="text-text-muted hover:text-text-bright shrink-0 rounded-lg p-1.5 transition-colors disabled:opacity-40"
              >
                {#if copied}
                  <CheckIcon class="size-4 text-emerald-400" />
                {:else}
                  <CopyIcon class="size-4" />
                {/if}
              </button>
            </div>
            <div class="flex items-center justify-between gap-2">
              {#if expired}
                <p class="text-amber-300 text-xs">{m.instance_setup_expired()}</p>
              {:else}
                <p class="text-text-muted text-xs">
                  {m.instance_setup_expires_in({ time: countdown })}
                </p>
              {/if}
              <button
                type="button"
                onclick={() => void mint()}
                class="text-text-muted hover:text-text-bright flex items-center gap-1 text-xs"
              >
                <RefreshCwIcon class="size-3" />
                {m.instance_setup_regenerate()}
              </button>
            </div>
          </div>
        {/if}

        <!-- KI-Assistent: fertiger Prompt mit Befehl + Referenz-URL -->
        {#if token && !expired}
          <div class="border-border rounded-xl border p-3">
            <p class="text-text-bright mb-1 text-xs font-semibold">
              {m.instance_setup_ai_title()}
            </p>
            <p class="text-text-muted mb-2 text-xs">{m.instance_setup_ai_hint()}</p>
            <div class="flex flex-wrap items-center gap-3">
              <button
                type="button"
                onclick={() => void copyAiPrompt()}
                class="border-border bg-bg-hover hover:text-text-bright flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs"
                data-testid="instance-setup-ai-copy"
              >
                {#if aiCopied}
                  <CheckIcon class="size-3.5 text-emerald-400" />
                {:else}
                  <CopyIcon class="size-3.5" />
                {/if}
                {m.instance_setup_ai_copy()}
              </button>
              <a
                href="{installBase}/install/guide"
                target="_blank"
                rel="noopener noreferrer"
                class="text-text-muted hover:text-text-bright text-xs underline"
              >
                {m.instance_setup_ai_guide_link()}
              </a>
            </div>
          </div>
        {/if}

        <!-- Manueller Pfad: Docker Compose statt Installer-Script -->
        <div class="border-border bg-bg-input/40 flex flex-col gap-2.5 rounded-xl border p-3">
          <p class="text-text-bright text-xs font-semibold tracking-wide uppercase">
            {m.instance_setup_manual_title()}
          </p>
          <p class="text-text-muted text-xs">{m.instance_setup_manual_desc()}</p>

          <button
            type="button"
            onclick={() => void downloadEnv()}
            disabled={envDownloading}
            class="bg-bg-hover border-border hover:text-text-bright flex w-fit items-center gap-2 rounded-lg border px-3 py-2 text-xs font-medium disabled:opacity-50"
            data-testid="instance-setup-env-download"
          >
            <DownloadIcon class="size-4" />
            {envDownloading ? m.instance_setup_manual_downloading() : m.instance_setup_manual_download()}
          </button>
          <p class="text-amber-300 text-xs">{m.instance_setup_manual_download_warning()}</p>

          <p class="text-text-muted text-xs">{m.instance_setup_manual_steps()}</p>
          <a
            href="{installBase}/self-host/guide"
            target="_blank"
            rel="noopener noreferrer"
            class="text-primary border-primary/40 hover:bg-primary/10 flex w-fit items-center gap-2 rounded-lg border px-3 py-2 text-xs font-semibold"
            data-testid="instance-setup-manual-link"
          >
            <ExternalLinkIcon class="size-3.5" />
            {m.instance_setup_manual_link()}
          </a>
        </div>

        <!-- Voraussetzungen -->
        <div class="border-border rounded-xl border p-3">
          <p class="text-text-bright mb-1.5 text-xs font-semibold">
            {m.instance_setup_prereqs_title()}
          </p>
          <ul class="text-text-muted flex list-disc flex-col gap-1 pl-4 text-xs">
            <li>{m.instance_setup_prereq_docker()}</li>
            <li>{m.instance_setup_prereq_ports()}</li>
            <li>{m.instance_setup_prereq_dns({ hostname: instance?.hostname ?? '' })}</li>
          </ul>
        </div>

        <!-- Erklärung -->
        <div>
          <button
            type="button"
            onclick={() => (showExplain = !showExplain)}
            class="text-text-muted hover:text-text-bright text-xs underline"
          >
            {m.instance_setup_explain_toggle()}
          </button>
          {#if showExplain}
            <ul class="text-text-muted mt-2 flex list-disc flex-col gap-1 pl-4 text-xs">
              <li>{m.instance_setup_explain_1()}</li>
              <li>{m.instance_setup_explain_2()}</li>
              <li>{m.instance_setup_explain_3()}</li>
              <li>
                <a
                  href="{installBase}/install"
                  target="_blank"
                  rel="noopener noreferrer"
                  class="text-primary underline">{m.instance_setup_explain_inspect()}</a
                >
              </li>
            </ul>
          {/if}
        </div>

      </div>

      <div class="flex justify-end pt-2">
        <button
          type="button"
          onclick={() => (open = false)}
          class="bg-primary hover:bg-primary/90 rounded-xl px-4 py-2 text-sm font-medium text-white"
        >
          {m.instance_setup_close()}
        </button>
      </div>
    </Dialog.Content>
  </Dialog.Portal>
</Dialog.Root>
