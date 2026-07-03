<!--
  Renderloser Side-effect: pusht Voice + Chat-Status als Canvas-Tray-Image
  an den Main-Prozess. Einmal in `+layout.svelte` eingebunden; im Browser
  ist `window.pulse?.tray` undefined → no-op.
-->
<script lang="ts">
  import { voice } from '$lib/voice/livekit.svelte';
  import { readState } from '$lib/stores/readState.svelte';
  import { settings } from '$lib/stores/settings.svelte';
  import { isElectron } from '$lib/platform/runtime';
  import { renderTrayPng, type TrayState } from './imageRenderer';

  $effect(() => {
    if (!isElectron() || !window.pulse?.tray) return;

    const inVoice = voice.connected;
    const muted = inVoice && !voice.micEnabled && !settings.voice.pttMode;
    const deafened = inVoice && voice.deafened;
    // "Nicht im Channel" ist kein Mute-Zustand — `voice.micEnabled` ist nach
    // Disconnect false, würde aber sonst fälschlich als "stumm" das Tray rot
    // zeichnen. Erst connected zeigt Mute/Deaf eine Farbe.
    let state: TrayState = 'normal';
    if (deafened) state = 'deaf';
    else if (muted) state = 'mute';

    const mentions = sumValues(readState.mentionCountByChannel);
    const unread = sumValues(readState.unreadCountByChannel);

    const dataUrl = renderTrayPng(state, unread, mentions);
    window.pulse.tray.setImage(dataUrl);
    window.pulse.tray.setStatus({ muted, deafened, unread, mentions });
  });

  function sumValues(o: Record<string, number>): number {
    let n = 0;
    for (const v of Object.values(o)) n += v;
    return n;
  }
</script>
