<!--
  Die Leiste unten: wie viel offen ist, verwerfen, speichern.

  Sie zählt über ALLE Ziele, nicht nur über das gerade gewählte — wer einen
  Kanal exklusiv macht, ändert zwei Ziele in einem Gedanken, und zwei getrennte
  Speicherknöpfe hätten dazwischen einen Zustand hinterlassen, in den niemand
  mehr hineinsieht.
-->
<script lang="ts">
  import { Button } from '$lib/components/ui/button/index.js';
  import { m } from '$lib/paraglide/messages.js';

  let {
    offen,
    speichert,
    onverwerfen,
    onspeichern
  }: {
    offen: number;
    speichert: boolean;
    onverwerfen: () => void;
    onspeichern: () => void;
  } = $props();
</script>

<div
  class="border-border bg-bg-input/60 mt-4 flex items-center justify-between gap-2 rounded-xl border px-3 py-2"
>
  <span class="text-text-muted text-xs" data-testid="perm-change-count">
    {offen === 0 ? m.kanalrechte_leiste_keine() : m.kanalrechte_leiste_anzahl({ count: offen })}
  </span>
  <div class="flex gap-2">
    <Button
      variant="ghost"
      size="sm"
      onclick={onverwerfen}
      disabled={offen === 0 || speichert}
      data-testid="perm-discard"
    >
      {m.kanalrechte_btn_verwerfen()}
    </Button>
    <Button
      size="sm"
      onclick={onspeichern}
      disabled={offen === 0 || speichert}
      data-testid="perm-save"
    >
      {speichert ? m.kanalrechte_btn_speichern_laeuft() : m.kanalrechte_btn_speichern()}
    </Button>
  </div>
</div>
