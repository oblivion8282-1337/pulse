<!--
  „Was macht dieser Befehl?" — aufklappbar, samt Verweis auf das Script selbst.
  Gehört zum Schnellweg, steht aber am Ende: wer den Befehl einfach ausführt,
  soll ihn zuerst sehen; wer wissen will, was er tut, liest weiter.
-->
<script lang="ts">
  import { m } from '$lib/paraglide/messages.js';
  import { Button } from '$lib/components/ui/button';

  let { base }: { base: string } = $props();

  let offen = $state(false);
</script>

<div>
  <Button variant="link" size="xs" onclick={() => (offen = !offen)}>
    {m.instance_setup_explain_toggle()}
  </Button>
  {#if offen}
    <ul class="text-text-muted mt-2 flex list-disc flex-col gap-1 pl-4 text-xs">
      <li>{m.instance_setup_explain_1()}</li>
      <li>{m.instance_setup_explain_2()}</li>
      <li>{m.instance_setup_explain_3()}</li>
      <li>
        <a
          href="{base}/install"
          target="_blank"
          rel="noopener noreferrer"
          class="text-primary underline">{m.instance_setup_explain_inspect()}</a
        >
      </li>
    </ul>
  {/if}
</div>
