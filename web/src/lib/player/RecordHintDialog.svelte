<!--
  RecordHintDialog — der EINMALIGE Hinweis vor der ersten Stream-Aufnahme.
  Global gemountet (im app/+layout), sichtbar solange `recordHinweis.offen`.
  Schließen ohne Wahl = nicht aufnehmen (sichere Vorgabe). „Aufnehmen"
  ist ein normaler Button, kein Default-Fokus — Zustimmung soll bewusst sein.

  Das ist die AGB-Hälfte der zweiten Aufnahme-Stufe (Entwurf 2026-09-15,
  Michaels GO 2026-09-27): der Zuschauer weiß, dass der Streamer informiert
  wird — und der Streamer weiß es dann auch.
-->
<script lang="ts">
  import * as Dialog from '$lib/components/ui/dialog/index.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import CircleAlertIcon from '@lucide/svelte/icons/circle-alert';
  import VideoIcon from '@lucide/svelte/icons/video';
  import Checkbox from '$lib/components/form/Checkbox.svelte';
  import { m } from '$lib/paraglide/messages.js';
  import { recordHinweis } from '$lib/stream/recordNotice.svelte';
</script>

<Dialog.Root bind:open={recordHinweis.offen}>
  <Dialog.Content class="max-w-md">
    <Dialog.Header>
      <Dialog.Title class="flex items-center gap-2">
        <CircleAlertIcon class="text-primary size-5" />
        {m.record_hint_title()}
      </Dialog.Title>
      <Dialog.Description>{m.record_hint_body()}</Dialog.Description>
    </Dialog.Header>

    <div class="text-text-muted flex items-start gap-3 rounded-xl border border-border bg-bg-input/40 p-3 text-sm">
      <VideoIcon class="text-text-muted mt-0.5 size-4 shrink-0" />
      {m.record_hint_inform()}
    </div>

    <label class="flex cursor-pointer items-center gap-2 text-sm">
      <Checkbox bind:checked={recordHinweis.merken} />
      {m.record_hint_remember()}
    </label>

    <Dialog.Footer>
      <Button variant="secondary" onclick={() => recordHinweis.entscheiden(false)}>
        {m.record_hint_cancel()}
      </Button>
      <Button onclick={() => recordHinweis.entscheiden(true)}>
        {m.record_hint_accept()}
      </Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
