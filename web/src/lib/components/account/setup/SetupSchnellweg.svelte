<!--
  Der Ein-Befehl-Installer: mintet beim Aufklappen einen One-Time-Bootstrap-
  Token (POST /me/instances/{id}/bootstrap-token) und zeigt den fertigen
  `curl … | bash`-Befehl mit Kopieren, Ablauf-Countdown und Neu-generieren.
  Der Token wird beim Einlösen auf dem Server verbraucht; das Pairing-Secret
  rotiert dabei serverseitig.

  Aus `InstanceSetupDialog` herausgelöst, als die Einrichtung vom Dialog zum
  Aufklappen wurde (2026-08-27). Ein Unterschied ist dabei wesentlich: der
  Dialog lebte durchgehend und schaltete über `open` um, dieses Stück wird
  beim Zuklappen ausgehängt. Der Zustand (Token, Countdown, „schon
  eingelöst") ist damit ohne eigenes `reset()` weg — genau das, was der alte
  `$effect` von Hand nachbauen musste, samt Generations-Wächter gegen einen
  Token, der aus einem überholten Aufruf für eine ANDERE Instanz eintrifft.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { toast } from 'svelte-sonner';
  import { m } from '$lib/paraglide/messages.js';
  import { ApiError } from '$lib/api/client';
  import { instancesApi, type Instance } from '$lib/api/instances';
  import BootstrapConsumedPanel from '../BootstrapConsumedPanel.svelte';
  import { Button } from '$lib/components/ui/button';
  import LoadingState from '$lib/components/feedback/LoadingState.svelte';
  import CopyIcon from '@lucide/svelte/icons/copy';
  import CheckIcon from '@lucide/svelte/icons/check';
  import RefreshCwIcon from '@lucide/svelte/icons/refresh-cw';

  let { instance, base }: { instance: Instance; base: string } = $props();

  let token = $state<string | null>(null);
  let expiresAtMs = $state(0);
  let loading = $state(false);
  let error = $state(false);
  // 403 beim Mint = Bootstrap wurde schon eingelöst → kein generischer Fehler,
  // sondern der erklärte „bereits eingerichtet"-Zustand mit bewusstem
  // Reset-Pfad (mint mit reset:true; der alte Server verliert den Zugang).
  let consumed = $state(false);
  let resetting = $state(false);
  let copied = $state(false);
  let nowMs = $state(Date.now());

  // Env-Form statt argv (`bash -s -- <token>`): Argumente sind während der
  // Script-Laufzeit für jeden lokalen User in `ps` sichtbar, Env-Variablen
  // nur für Owner/Root. Das Script liest beides (install.sh: PULSE_BOOTSTRAP_TOKEN).
  let command = $derived(
    token ? `curl -fsSL ${base}/install | PULSE_BOOTSTRAP_TOKEN=${token} bash` : ''
  );
  let remainingMs = $derived(Math.max(0, expiresAtMs - nowMs));
  let expired = $derived(token !== null && expiresAtMs > 0 && remainingMs <= 0);
  let countdown = $derived(formatRemaining(remainingMs));

  // Ab einer Stunde mit Stunden-Teil: die Token-Gültigkeit liegt bei 2 h, und
  // reines mm:ss zeigte dafür „120:00" — das liest niemand als zwei Stunden.
  function formatRemaining(ms: number): string {
    const total = Math.floor(ms / 1000);
    const hh = Math.floor(total / 3600);
    const mm = Math.floor(total / 60) % 60;
    const ss = total % 60;
    const pad = (n: number) => n.toString().padStart(2, '0');
    return hh > 0 ? `${hh}:${pad(mm)}:${pad(ss)}` : `${mm}:${pad(ss)}`;
  }

  async function mint(reset = false) {
    if (loading) return;
    loading = true;
    error = false;
    consumed = false;
    try {
      const res = await instancesApi.mintBootstrapToken(
        instance.id,
        reset ? { reset: true } : undefined
      );
      token = res.token;
      expiresAtMs = new Date(res.expires_at).getTime();
      nowMs = Date.now();
    } catch (e) {
      token = null;
      if (e instanceof ApiError && e.status === 403) consumed = true;
      else error = true;
    } finally {
      loading = false;
      resetting = false;
    }
  }

  async function inZwischenablage(text: string, gesetzt: (v: boolean) => void) {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      gesetzt(true);
      setTimeout(() => gesetzt(false), 1500);
    } catch {
      toast.error(m.instance_setup_error());
    }
  }

  onMount(() => {
    void mint();
    const ticker = setInterval(() => (nowMs = Date.now()), 1000);
    return () => clearInterval(ticker);
  });
</script>

<p class="text-text-bright text-xs font-semibold tracking-wide uppercase">
  {m.instance_setup_quick_title()}
</p>

{#if loading && !token}
  <LoadingState label={m.instance_setup_loading()} />
{:else if consumed}
  <BootstrapConsumedPanel {resetting} onreset={() => { resetting = true; void mint(true); }} />
{:else if error}
  <div
    class="border-destructive/30 bg-destructive/10 flex items-center justify-between gap-3 rounded-xl border p-3"
  >
    <p class="text-destructive text-xs">{m.instance_setup_error()}</p>
    <Button variant="outline" size="xs" onclick={() => void mint()}>
      <RefreshCwIcon class="size-3.5" />
      {m.instance_setup_regenerate()}
    </Button>
  </div>
{:else if token}
  <div class="flex flex-col gap-2">
    <div class="bg-bg-input border-border flex items-start gap-2 rounded-xl border p-3">
      <code
        class="text-text-bright min-w-0 flex-1 break-all font-mono text-xs leading-relaxed {expired
          ? 'opacity-40'
          : ''}"
        data-testid="instance-setup-command">{command}</code
      >
      <Button
        variant="ghost"
        size="icon-sm"
        class="shrink-0"
        onclick={() => void inZwischenablage(command, (v) => (copied = v))}
        disabled={expired}
        aria-label={m.instance_setup_copy()}
      >
        {#if copied}
          <CheckIcon class="size-4 text-success" />
        {:else}
          <CopyIcon class="size-4" />
        {/if}
      </Button>
    </div>
    <div class="flex items-center justify-between gap-2">
      {#if expired}
        <p class="text-warning text-xs">{m.instance_setup_expired()}</p>
      {:else}
        <p class="text-text-muted text-xs">{m.instance_setup_expires_in({ time: countdown })}</p>
      {/if}
      <Button variant="ghost" size="xs" onclick={() => void mint()}>
        <RefreshCwIcon class="size-3" />
        {m.instance_setup_regenerate()}
      </Button>
    </div>
  </div>
{/if}
