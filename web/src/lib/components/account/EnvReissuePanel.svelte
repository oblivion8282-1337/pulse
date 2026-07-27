<!--
  „.env bereits heruntergeladen"-Zustand im InstanceSetupDialog (403 beim
  Download). Erklärtext + bewusster Neu-Ausstellen-Pfad mit Inline-
  Bestätigung — ein bereits damit laufender Server verliert dabei sofort
  seinen Zugang, weil der Download das client_secret rotiert.

  Bewusst dieselbe Form wie BootstrapConsumedPanel: es ist derselbe Gedanke
  („Zugang neu ausstellen"), und zwei verschiedene Darstellungen dafür wären
  im selben Dialog nur verwirrend. Eigene Komponente wegen der 250-Zeilen-
  Policy des Dialogs.
-->
<script lang="ts">
  import { Button } from '$lib/components/ui/button';
  import { m } from '$lib/paraglide/messages.js';

  let { busy, onreissue }: { busy: boolean; onreissue: () => void } = $props();

  let confirm = $state(false);
</script>

<div
  class="border-warning/30 bg-warning/10 flex flex-col gap-2 rounded-xl border p-3"
  data-testid="instance-setup-env-consumed"
>
  <p class="text-warning text-xs font-semibold">{m.instance_setup_env_consumed_title()}</p>
  <p class="text-text-muted text-xs">{m.instance_setup_env_consumed_body()}</p>
  {#if confirm}
    <p class="text-destructive text-xs">{m.instance_setup_env_reissue_confirm_body()}</p>
    <div class="flex gap-2">
      <Button variant="ghost" size="xs" onclick={() => (confirm = false)}>
        {m.admin_instances_pending_cancel()}
      </Button>
      <Button
        variant="destructive-solid"
        size="xs"
        onclick={() => {
          confirm = false;
          onreissue();
        }}
        disabled={busy}
        data-testid="instance-setup-env-reissue-confirm"
      >
        {m.instance_setup_env_reissue_confirm_btn()}
      </Button>
    </div>
  {:else}
    <Button
      variant="outline"
      size="xs"
      class="w-fit"
      onclick={() => (confirm = true)}
      data-testid="instance-setup-env-reissue"
    >
      {m.instance_setup_env_reissue_btn()}
    </Button>
  {/if}
</div>
