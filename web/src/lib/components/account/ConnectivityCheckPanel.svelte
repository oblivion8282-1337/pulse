<!--
  Anschluss-Check im App-Host-Zweig des Antragsformulars — auf die EINZIGE
  wertvolle Aussage eingedampft (Entscheidung 2026-07-13, Variante B): die
  STUN-Probe läuft STILL im Hintergrund (kein Knopf, keine Ampel). NUR wenn
  der Anschluss physikalisch nicht von zuhause hosten kann (DS-Lite/CGNAT oder
  keine Direktverbindung), erscheint eine rote Warn-Box + der Parent blockiert
  den Submit. Jedes andere Ergebnis (ok / Timeout / Fehler) zeigt nichts.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { m } from '$lib/paraglide/messages.js';
  import { runConnectivityCheck, type HostingVerdict } from '$lib/hosting/connectivityCheck';

  let { onresult }: { onresult: (r: HostingVerdict) => void } = $props();

  let verdict = $state<HostingVerdict | null>(null);

  onMount(async () => {
    // Läuft still im Hintergrund; das Ergebnis meldet der Parent (blockt den
    // Submit nur bei 'cannot-host') und speichert es mit dem Antrag.
    const r = await runConnectivityCheck();
    verdict = r;
    onresult(r);
  });
</script>

{#if verdict === 'cannot-host'}
  <div
    class="rounded-xl border border-destructive/30 bg-destructive/10 p-2.5 text-xs text-destructive"
    data-testid="connectivity-check-warning"
  >
    <p>{m.net_check_cannot_host()}</p>
    <p class="mt-1">{m.net_check_vps_alternative()}</p>
    <p class="text-text-muted mt-1">{m.net_check_hint()}</p>
  </div>
{/if}
