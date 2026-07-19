<!--
  Bestätigungs-Dialog vor dem ERSTEN Kontakt mit einem neuen, unbekannten
  Self-Host-Server (Stufe-3-Sicherheits-Gate).

  Ersetzt den früheren ``/invite/[code]?host=``-Disclaimer: Bevor der Client
  eine Cert-Challenge gegen einen fremden Host schickt (die IP/Zeitpunkt/
  pairwise_sub leaken würde), muss der User den Hostnamen sehen und bestätigen.

  Controlled via ``open`` + ``hostname`` (Props). ``onConfirm`` / ``onCancel``
  werden vom Caller geliefert; der Caller startet nach onConfirm den Join
  erneut mit ``confirmed: true``.

  Der bits-ui-AlertDialog-Wrapper kennt nur ``bind:open`` (kein onOpenChange),
  daher spiegeln wir das ``open``-Prop in einen lokalen Bind und feuern
  ``onCancel`` bei jedem User-getriebenen Schließen (Escape/Cancel/Backdrop).
-->
<script lang="ts">
  import * as AlertDialog from '$lib/components/ui/alert-dialog/index.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import ShieldAlertIcon from '@lucide/svelte/icons/shield-alert';
  import { m } from '$lib/paraglide/messages.js';

  let {
    open = false,
    hostname = '',
    onConfirm,
    onCancel
  }: {
    open?: boolean;
    hostname?: string;
    onConfirm: () => void;
    onCancel: () => void;
  } = $props();

  // Lokaler Bind-State, gespiegelt vom kontrollierten ``open``-Prop.
  let internalOpen = $state(false);
  // Verhindert, dass das Confirm-Schließen als Cancel fehlinterpretiert wird.
  let confirming = false;

  $effect(() => {
    internalOpen = open;
  });

  // User-getriebenes Schließen (Escape/Cancel/Backdrop) → onCancel, sofern es
  // nicht das Schließen nach einer Bestätigung war.
  $effect(() => {
    if (!internalOpen && open && !confirming) {
      onCancel();
    }
  });

  function handleConfirm() {
    confirming = true;
    internalOpen = false;
    onConfirm();
    confirming = false;
  }

  /** Bare FQDN ohne https:// für die Anzeige. */
  let displayHost = $derived(hostname.replace(/^https?:\/\//, ''));
</script>

<AlertDialog.Root bind:open={internalOpen}>
  <AlertDialog.Content data-testid="self-host-contact-confirm-dialog">
    <AlertDialog.Header>
      <AlertDialog.Title>
        <span class="flex items-center gap-2 text-warning">
          <ShieldAlertIcon class="size-5" />
          {m.self_host_contact_confirm_title()}
        </span>
      </AlertDialog.Title>
      <AlertDialog.Description>
        {m.self_host_contact_confirm_intro()}
      </AlertDialog.Description>
    </AlertDialog.Header>

    <p
      class="text-text-bright break-all rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-center font-mono text-sm font-medium"
      data-testid="self-host-contact-confirm-host"
    >
      {displayHost}
    </p>
    <p class="text-text-muted text-xs">
      {m.self_host_contact_confirm_hint()}
    </p>

    <AlertDialog.Footer>
      <AlertDialog.Cancel>
        {m.self_host_contact_confirm_cancel()}
      </AlertDialog.Cancel>
      <Button onclick={handleConfirm} data-testid="self-host-contact-confirm-confirm">
        {m.self_host_contact_confirm_confirm()}
      </Button>
    </AlertDialog.Footer>
  </AlertDialog.Content>
</AlertDialog.Root>
