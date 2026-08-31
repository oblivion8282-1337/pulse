<script lang="ts">
  /** Der Aktiv-Zustand der Sicherung — Statuszeile und die zwei Aktionen.
   *  Eigenständig, damit die Sektion unter der Komponenten-Policy bleibt. */
  import { Button } from '$lib/components/ui/button/index.js';

  const { meldung, ordnerModus, aufJetztSichern, aufZugriff, aufEntfernen } = $props<{
    meldung: string;
    ordnerModus: boolean;
    aufJetztSichern: () => void;
    aufZugriff: () => void;
    aufEntfernen: () => void;
  }>();
</script>

<p class="text-sm text-muted-foreground">
  Aktiv — deine Nachrichten werden gesichert. {meldung}
</p>
<div class="flex flex-wrap items-center gap-2">
  <Button variant="secondary" size="sm" onclick={aufJetztSichern}>Jetzt sichern</Button>
  {#if ordnerModus}
    <Button variant="secondary" size="sm" onclick={aufZugriff}>Ordner-Zugriff erneuern</Button>
  {/if}
  <button class="text-xs text-destructive hover:underline" onclick={aufEntfernen}>Entfernen</button>
</div>
