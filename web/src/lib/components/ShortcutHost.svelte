<script lang="ts">
  /**
   * Mount-point für das globale Shortcut-System. Eine Instanz, im Root-
   * `+layout.svelte` platziert. Hier laufen das Window-Level-Keydown +
   * die Global-Action-Handler die nicht an eine konkrete Feature-View
   * gebunden sind (aktuell: Cheatsheet-Overlay).
   *
   * Feature-Views (VoiceChannelView, MessageInput, Stream-Panel) holen sich
   * `register()` aus engine.svelte.ts und registrieren ihre Handler selbst.
   */
  import { onMount } from 'svelte';
  import { mountWindowListener, register } from '$lib/shortcuts/engine.svelte';
  import ShortcutCheatsheet from './ShortcutCheatsheet.svelte';

  let cheatsheetOpen = $state(false);

  onMount(() => {
    const disposers: Array<() => void> = [
      mountWindowListener(),
      register('nav.cheatsheet', () => {
        cheatsheetOpen = !cheatsheetOpen;
      })
    ];
    return () => disposers.forEach((d) => d());
  });
</script>

<ShortcutCheatsheet bind:open={cheatsheetOpen} />
