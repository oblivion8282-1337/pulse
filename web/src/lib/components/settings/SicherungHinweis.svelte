<script lang="ts">
  /**
   * Frischgerät-Hinweis der Sicherung: Der lokale Verlauf ist leer, weil die
   * Nachrichten verschlüsselt im Cloud-Archiv liegen — Verbinden + Passwort
   * holt sie. Sprung in den Sicherungs-Tab (Muster `DmOhneAppGeraet`):
   * Desktop der Dialog, mobil die Route. Rein präsentativ; die Aktiv-Prüfung
   * liegt beim Aufrufer (`@me`-Seite).
   */
  import { goto } from '$app/navigation';
  import { m } from '$lib/paraglide/messages.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import { uiOverlays } from '$lib/stores/uiOverlays.svelte';
  import { viewport } from '$lib/stores/viewport.svelte';
  import CloudUploadIcon from '@lucide/svelte/icons/cloud-upload';

  function zuSicherung(): void {
    if (viewport.isMobile) void goto('/app/me/sicherung');
    else uiOverlays.openSettings('sicherung');
  }
</script>

<div
  class="flex max-w-sm flex-col items-center gap-2 rounded-xl border border-border p-3"
  data-testid="sicherung-hinweis"
>
  <p class="text-text-muted text-center text-xs">{m.sicherung_hinweis_text()}</p>
  <Button variant="outline" size="sm" class="gap-1.5" onclick={zuSicherung}>
    <CloudUploadIcon class="size-3.5" />
    {m.sicherung_hinweis_knopf()}
  </Button>
</div>
