<!--
  SelfHostDisclaimer — Phase 4.3.

  Sichtbar wenn der aktive Server NICHT Cloud ist UND der User den Hinweis
  für genau diesen Server noch nicht bestätigt hat. Die Bestätigung gilt
  „einmal pro Server, geräteübergreifend": sie wird auf dem jeweiligen
  Server gespeichert (user_preferences, s. $lib/api/disclaimer-ack) und
  hier beim Server-Wechsel abgefragt; localStorage bleibt Fast-Path-Cache.

  Mini-Toast/Banner unterhalb des UpdateBanners. Schließbar per "Verstanden".
-->
<script lang="ts">
  import ShieldAlertIcon from '@lucide/svelte/icons/shield-alert';
  import { Button } from '$lib/components/ui/button/index.js';
  import { activeServer } from '$lib/stores/active-server.svelte';
  import {
    disclaimerSeenLocally,
    fetchDisclaimerAck,
    markDisclaimerSeenLocally,
    persistDisclaimerAck
  } from '$lib/api/disclaimer-ack';
  import { m } from '$lib/paraglide/messages.js';

  // serverId → Server-Antwort (true = bestätigt, false = zeigen).
  // undefined = noch nicht abgefragt → Banner bleibt verborgen (kein Flackern
  // während des Roundtrips).
  let ackByServer = $state<Record<string, boolean>>({});

  let active = $derived(activeServer.current);

  $effect(() => {
    const a = active;
    if (!a || a.isCloud) return;
    if (disclaimerSeenLocally(a.id)) return;
    if (ackByServer[a.id] !== undefined) return;
    void check(a.id);
  });

  async function check(serverId: string): Promise<void> {
    const seen = await fetchDisclaimerAck(serverId);
    // null (offline/Fehler) → zeigen: lieber einmal zu viel hinweisen als den
    // Hinweis auf einem unbekannten Server zu verschlucken.
    ackByServer = { ...ackByServer, [serverId]: seen === true };
    // Server sagt "bestätigt" → nur den lokalen Cache setzen, kein Rück-PUT.
    if (seen === true) markDisclaimerSeenLocally(serverId);
  }

  function dismiss(serverId: string): void {
    persistDisclaimerAck(serverId);
    ackByServer = { ...ackByServer, [serverId]: true };
  }

  let visible = $derived(
    !!active &&
      !active.isCloud &&
      !disclaimerSeenLocally(active.id) &&
      ackByServer[active.id] === false
  );
</script>

{#if visible && active}
  <div
    class="mx-3 mt-2 flex items-center gap-3 rounded-xl border border-warning/40 bg-warning/15 px-3 py-2 text-sm text-warning"
    data-testid="self-host-disclaimer-toast"
    role="note"
  >
    <ShieldAlertIcon class="size-4 shrink-0" />
    <span class="flex-1">
      {m.self_host_disclaimer_notice_before()} <strong>{active.label}</strong>{m.self_host_disclaimer_notice_after()}
    </span>
    <Button
      size="sm"
      variant="outline"
      onclick={() => dismiss(active.id)}
      data-testid="self-host-disclaimer-ack"
    >
      {m.self_host_disclaimer_ack()}
    </Button>
  </div>
{/if}
