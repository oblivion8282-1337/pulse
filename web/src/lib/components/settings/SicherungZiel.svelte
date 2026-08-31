<script lang="ts">
  /** Die Ziel-Wahl der Sicherung: Google Drive oder ein Ordner auf diesem
   *  Computer (z. B. im Dropbox-/OneDrive-Sync). Rein präsentativ — die
   *  Logik liegt in der Sektion. */
  import { Button } from '$lib/components/ui/button/index.js';
  import { syncOrdnerMoeglich } from '$lib/ablage/syncOrdner';
  import { isElectron } from '$lib/platform/runtime';

  const { laeuft, aufGoogle, aufOrdner } = $props<{
    laeuft: boolean;
    aufGoogle: () => void;
    aufOrdner: () => void;
  }>();
</script>

<div class="space-y-2">
  <div class="flex flex-wrap items-center gap-2">
    <Button onclick={aufGoogle} size="sm" disabled={laeuft}>
      {laeuft ? 'Warte auf Google …' : 'Mit Google Drive verbinden'}
    </Button>
    {#if syncOrdnerMoeglich()}
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
