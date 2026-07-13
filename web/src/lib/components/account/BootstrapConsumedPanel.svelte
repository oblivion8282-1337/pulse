<!--
  „Server bereits eingerichtet"-Zustand im InstanceSetupDialog (403 beim
  Auto-Mint = Bootstrap schon eingelöst). Erklärtext + bewusster Reset-Pfad
  mit Inline-Bestätigung — der bisher eingerichtete Server verliert beim
  Reset sofort seinen Zugang (Mint mit reset:true rotiert die Credentials).
  Eigene Komponente wegen der 250-Zeilen-Policy des Dialogs.
-->
<script lang="ts">
  import { m } from '$lib/paraglide/messages.js';

  let { resetting, onreset }: { resetting: boolean; onreset: () => void } = $props();

  let confirm = $state(false);
</script>

<div class="flex flex-col gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 p-3"
     data-testid="instance-setup-consumed">
  <p class="text-amber-200 text-xs font-semibold">{m.instance_setup_consumed_title()}</p>
  <p class="text-text-muted text-xs">{m.instance_setup_consumed_body()}</p>
  {#if confirm}
    <p class="text-red-300 text-xs">{m.instance_setup_reset_confirm_body()}</p>
    <div class="flex gap-2">
      <button type="button" onclick={() => (confirm = false)}
        class="rounded-lg border border-border px-3 py-1.5 text-xs text-text-base hover:bg-bg-hover">
        {m.admin_instances_pending_cancel()}
      </button>
      <button type="button" onclick={() => { confirm = false; onreset(); }} disabled={resetting}
        class="rounded-lg bg-red-600/80 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-500 disabled:opacity-60"
        data-testid="instance-setup-reset-confirm">
        {m.instance_setup_reset_confirm_btn()}
      </button>
    </div>
  {:else}
    <button type="button" onclick={() => (confirm = true)}
      class="w-fit rounded-lg border border-border bg-bg-hover px-3 py-1.5 text-xs font-medium hover:text-text-bright"
      data-testid="instance-setup-reset">
      {m.instance_setup_reset_btn()}
    </button>
  {/if}
</div>
