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
  import { voice } from '$lib/voice/livekit.svelte';
  import ShortcutCheatsheet from './ShortcutCheatsheet.svelte';

  let cheatsheetOpen = $state(false);

  onMount(() => {
    const disposers: Array<() => void> = [
      mountWindowListener(),
      register('nav.cheatsheet', () => {
        cheatsheetOpen = !cheatsheetOpen;
      }),
      // Voice-Actions sind global (auch außerhalb der VoiceChannelView nutzbar,
      // sobald man im Voice ist — Discord-Style). Guards verhindern, dass
      // toggleMic()s Sound spielt ohne dass Connection da ist.
      register('voice.toggleMute', () => {
        if (!voice.connected) return;
        voice.toggleMic();
      }),
      register('voice.toggleDeafen', () => {
        if (!voice.connected) return;
        voice.toggleDeafen();
      }),
      register('voice.disconnect', () => {
        if (!voice.connected) return;
        void voice.disconnect({ reason: 'user' });
      })
    ];
    return () => disposers.forEach((d) => d());
  });
</script>

<ShortcutCheatsheet bind:open={cheatsheetOpen} />
