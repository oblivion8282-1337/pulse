<!--
  Gemeinsames Warn-Panel mit Inline-Bestätigung für „Zugang neu ausstellen"-
  Abläufe im InstanceSetupDialog (Bootstrap-Reset, .env-Neu-Ausstellen).
  Erklärtext + bewusster Reset-Pfad: beim Bestätigen verliert der bisher
  eingerichtete Server sofort seinen Zugang (die Credentials werden rotiert).
  Eigene Komponente wegen der 250-Zeilen-Policy des Dialogs.
-->
<script lang="ts">
  import { Button } from '$lib/components/ui/button';

  let {
    /** Test-ID-Präfix: `<testid>` für den Auslöser, `<testid>-confirm` für
     *  den Bestätigungs-Knopf. */
    testid,
    title,
    body,
    confirmBody,
    confirmBtn,
    resetBtn,
    busy,
    onreset
  }: {
    testid: string;
    title: string;
    body: string;
    confirmBody: string;
    confirmBtn: string;
    resetBtn: string;
    busy: boolean;
    onreset: () => void;
  } = $props();

  let confirm = $state(false);
</script>

<div class="border-warning/30 bg-warning/10 flex flex-col gap-2 rounded-xl border p-3" data-testid={testid}>
  <p class="text-warning text-xs font-semibold">{title}</p>
  <p class="text-text-muted text-xs">{body}</p>
  {#if confirm}
    <p class="text-destructive text-xs">{confirmBody}</p>
    <div class="flex gap-2">
      <Button variant="ghost" size="xs" onclick={() => (confirm = false)}>
        {confirmBtn}
      </Button>
      <Button
        variant="destructive-solid"
        size="xs"
        onclick={() => {
          confirm = false;
          onreset();
        }}
        disabled={busy}
        data-testid="{testid}-confirm">
        {resetBtn}
      </Button>
    </div>
  {:else}
    <Button
      variant="outline"
      size="xs"
      class="w-fit"
      onclick={() => (confirm = true)}
      data-testid={testid}
    >
      {resetBtn}
    </Button>
  {/if}
</div>
