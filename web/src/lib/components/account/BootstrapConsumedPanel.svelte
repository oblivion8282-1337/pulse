<!--
  „Server bereits eingerichtet"-Zustand im InstanceSetupDialog (403 beim
  Auto-Mint = Bootstrap schon eingelöst). Erklärtext + bewusster Reset-Pfad
  mit Inline-Bestätigung — der bisher eingerichtete Server verliert beim
  Reset sofort seinen Zugang (Mint mit reset:true rotiert die Credentials).
  Eigene Komponente wegen der 250-Zeilen-Policy des Dialogs.
-->
<script lang="ts">
  import { Button } from '$lib/components/ui/button';
  import { m } from '$lib/paraglide/messages.js';

  let { resetting, onreset }: { resetting: boolean; onreset: () => void } = $props();

  let confirm = $state(false);
</script>

<div class="flex flex-col gap-2 rounded-xl border border-warning/30 bg-warning/10 p-3"
     data-testid="instance-setup-consumed">
  <p class="text-warning text-xs font-semibold">{m.instance_setup_consumed_title()}</p>
  <p class="text-text-muted text-xs">{m.instance_setup_consumed_body()}</p>
  {#if confirm}
    <p class="text-destructive text-xs">{m.instance_setup_reset_confirm_body()}</p>
    <div class="flex gap-2">
      <Button variant="ghost" size="xs" onclick={() => (confirm = false)}>
        {m.admin_instances_pending_cancel()}
      </Button>
      <Button
        variant="destructive-solid"
        size="xs"
        onclick={() => { confirm = false; onreset(); }}
        disabled={resetting}
        data-testid="instance-setup-reset-confirm">
        {m.instance_setup_reset_confirm_btn()}
      </Button>
    </div>
  {:else}
    <Button
      variant="outline"
      size="xs"
      class="w-fit"
      onclick={() => (confirm = true)}
      data-testid="instance-setup-reset">
      {m.instance_setup_reset_btn()}
    </Button>
  {/if}
</div>
