<!--
  Anschluss-Check (Stufe 1, beratend) im App-Host-Zweig des Antragsformulars.

  Pflichtschritt vor dem Absenden: die STUN-Probe (lib/hosting/
  connectivityCheck) klassifiziert den Anschluss. 'blocked'/'cgnat'/
  'symmetric' blockieren den Submit mit erklärtem Grund (VPS-Weg wird als
  Alternative genannt); 'unknown' erlaubt ihn (beratend). Das Ergebnis meldet
  der Parent über `onresult` und speichert es mit dem Antrag (network_check).
-->
<script lang="ts">
  import { m } from '$lib/paraglide/messages.js';
  import {
    runConnectivityCheck,
    type NetworkCheckResult
  } from '$lib/hosting/connectivityCheck';
  import WifiIcon from '@lucide/svelte/icons/wifi';
  import LoaderCircleIcon from '@lucide/svelte/icons/loader-circle';

  let { onresult }: { onresult: (r: NetworkCheckResult) => void } = $props();

  let running = $state(false);
  let result = $state<NetworkCheckResult | null>(null);

  async function run() {
    if (running) return;
    running = true;
    try {
      result = await runConnectivityCheck();
      onresult(result);
    } finally {
      running = false;
    }
  }

  const RESULT_TEXT: Record<NetworkCheckResult, () => string> = {
    ok: () => m.net_check_ok(),
    blocked: () => m.net_check_blocked(),
    cgnat: () => m.net_check_cgnat(),
    symmetric: () => m.net_check_symmetric(),
    unknown: () => m.net_check_unknown()
  };

  function resultClass(r: NetworkCheckResult): string {
    if (r === 'ok') return 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300';
    if (r === 'unknown') return 'border-border bg-bg-input/40 text-text-muted';
    return 'border-red-500/30 bg-red-500/10 text-red-300';
  }
</script>

<div class="border-border bg-bg-input/30 flex flex-col gap-2 rounded-xl border p-3"
     data-testid="connectivity-check">
  <p class="text-text-bright text-xs font-semibold">{m.net_check_title()}</p>
  <p class="text-text-muted text-xs">{m.net_check_hint()}</p>

  <button
    type="button"
    onclick={() => void run()}
    disabled={running}
    class="bg-bg-hover border-border hover:text-text-bright flex w-fit items-center gap-2 rounded-lg border px-3 py-1.5 text-xs font-medium disabled:opacity-60"
    data-testid="connectivity-check-run"
  >
    {#if running}
      <LoaderCircleIcon class="size-3.5 animate-spin" />
      {m.net_check_running()}
    {:else}
      <WifiIcon class="size-3.5" />
      {m.net_check_run_btn()}
    {/if}
  </button>

  {#if result}
    <div class="rounded-lg border p-2.5 text-xs {resultClass(result)}"
         data-testid="connectivity-check-result" data-result={result}>
      <p>{RESULT_TEXT[result]()}</p>
      {#if result === 'cgnat'}
        <p class="mt-1">{m.net_check_cgnat_advice()}</p>
      {/if}
      {#if result === 'cgnat' || result === 'symmetric' || result === 'blocked'}
        <p class="mt-1">{m.net_check_vps_alternative()}</p>
      {/if}
    </div>
  {/if}
</div>
