<script lang="ts">
  /** Die Ziel-Wahl der Sicherung: Google Drive und/oder ein Ordner auf
   *  diesem Computer (z. B. im Dropbox-/OneDrive-Sync). Beide Ziele sind
   *  unabhängig kombiniert — gesetzte zeigen ✓, fehlende lassen sich
   *  hinzufügen. Rein präsentativ; die Logik liegt in der Sektion. */
  import { Button } from '$lib/components/ui/button/index.js';
  import { syncOrdnerMoeglich } from '$lib/ablage/syncOrdner';
  import { isElectron } from '$lib/platform/runtime';

  const { laeuft, gdriveAktiv, ordnerAktiv, aufGoogle, aufOrdner } = $props<{
    laeuft: boolean;
    gdriveAktiv: boolean;
    ordnerAktiv: boolean;
    aufGoogle: () => void;
    aufOrdner: () => void;
  }>();
</script>

<div class="space-y-2">
  <div class="flex flex-wrap items-center gap-2">
    {#if gdriveAktiv}
      <span class="text-sm text-muted-foreground">✓ Google Drive verbunden</span>
    {:else}
      <Button onclick={aufGoogle} size="sm" disabled={laeuft}>
        {laeuft ? 'Warte auf Google …' : 'Mit Google Drive verbinden'}
      </Button>
    {/if}
    {#if ordnerAktiv}
      <span class="text-sm text-muted-foreground">✓ Ordner gewählt</span>
    {:else if syncOrdnerMoeglich()}
      <Button onclick={aufOrdner} variant="secondary" size="sm" disabled={laeuft}>
        Ordner auf diesem Computer wählen
      </Button>
    {/if}
  </div>
  <p class="text-xs text-muted-foreground">
    {#if isElectron()}
      Google: der Browser öffnet sich — Pulse fängt die Rückkehr automatisch ab. Ordner: z. B. in deinem Dropbox-/OneDrive-Sync.
    {:else}
      Google öffnet sich in einem neuen Tab; am Ende kommst du hierher zurück.
    {/if}
  </p>
</div>
