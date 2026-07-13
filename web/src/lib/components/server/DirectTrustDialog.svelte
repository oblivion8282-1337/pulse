<!--
  Vertrauens-Dialog beim Fingerprint-Wechsel eines Direct-only-Servers
  (App-Host). Früher: console.warn + stiller Relay-Fallback — jetzt ein
  sichtbarer Entscheidungs-Moment: Die Identität des Servers hat sich
  geändert (erwartbar nach Neueinrichtung/Umzug durch den Betreiber,
  verdächtig sonst). "Neuer Identität vertrauen" vergisst den TOFU-Pin und
  verbindet neu; Abbrechen lässt den Server im Fehlzustand.
-->
<script lang="ts">
  import * as AlertDialog from '$lib/components/ui/alert-dialog/index.js';
  import { m } from '$lib/paraglide/messages.js';
  import { directStatus } from '$lib/stores/directStatus.svelte';
  import { serversStore, serverDisplayName } from '$lib/api/servers.svelte';
  import { forgetPin } from '$lib/direct/registry';
  import { gatewayPool } from '$lib/ws/gateway-pool.svelte';

  const entry = $derived(
    directStatus.trustPrompt
      ? serversStore.servers.find((s) => s.instance_id === directStatus.trustPrompt)
      : undefined
  );
  const open = $derived(directStatus.trustPrompt !== null);

  function trust() {
    const instanceId = directStatus.trustPrompt;
    if (!instanceId) return;
    // Entry VOR dem clear() greifen — das $derived hängt am trustPrompt.
    const target = entry;
    forgetPin(instanceId);
    directStatus.clear(instanceId);
    // Sofort neu verbinden — forgetPin hat den Fehlschlag-Cache geleert.
    if (target) void gatewayPool.for(target.id).connect().catch(() => undefined);
  }

  function cancel() {
    // Fehlzustand bleibt sichtbar (Tooltip/Dot); nur der Dialog schließt.
    directStatus.dismissTrustPrompt();
  }
</script>

<AlertDialog.Root bind:open={() => open, (v: boolean) => { if (!v) cancel(); }}>
  <AlertDialog.Content data-testid="direct-trust-dialog">
    <AlertDialog.Header>
      <AlertDialog.Title>{m.direct_trust_title()}</AlertDialog.Title>
      <AlertDialog.Description>
        {m.direct_trust_body({ label: entry ? serverDisplayName(entry) : '' })}
      </AlertDialog.Description>
    </AlertDialog.Header>
    <AlertDialog.Footer>
      <!-- Schließen (Cancel/ESC) läuft über den bind-Setter → cancel(). -->
      <AlertDialog.Cancel>{m.direct_trust_cancel()}</AlertDialog.Cancel>
      <AlertDialog.Action onclick={trust} data-testid="direct-trust-accept">
        {m.direct_trust_accept()}
      </AlertDialog.Action>
    </AlertDialog.Footer>
  </AlertDialog.Content>
</AlertDialog.Root>
