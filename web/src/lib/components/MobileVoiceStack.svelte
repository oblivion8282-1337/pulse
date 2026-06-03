<script lang="ts">
  import VoiceChannelView from './VoiceChannelView.svelte';
  import type { Channel } from '$lib/api/types';
  import type { Snippet } from 'svelte';

  let {
    voiceChannel,
    onReturnToVoice,
    chat
  }: {
    /** Der Voice-Kanal, mit dem wir verbunden sind (untere Karte). */
    voiceChannel: Channel;
    /** Zurück zum vollen Voice-Kanal (= goto auf dessen URL). */
    onReturnToVoice: () => void;
    /** Inhalt der oberen Karte (vom Aufrufer gerenderte ChatView). */
    chat: Snippet;
  } = $props();

  // Wie weit der Voice-Kanal oben aus dem Stapel herausschaut.
  const PEEK = 96;
  // Wisch-Distanz nach unten, ab der zum Voice-Kanal zurückgekehrt wird.
  const DISMISS_THRESHOLD = 80;

  let dragY = $state(0);
  let dragging = $state(false);
  let startY = 0;

  function onPointerDown(e: PointerEvent) {
    dragging = true;
    startY = e.clientY;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }
  function onPointerMove(e: PointerEvent) {
    if (!dragging) return;
    dragY = Math.max(0, e.clientY - startY);
  }
  function onPointerUp() {
    if (!dragging) return;
    dragging = false;
    const dismiss = dragY > DISMISS_THRESHOLD;
    dragY = 0;
    if (dismiss) onReturnToVoice();
  }
</script>

<div class="relative flex h-full min-h-0 flex-1 flex-col" data-testid="mobile-voice-stack">
  <!-- Untere Karte: der verbundene Voice-Kanal, oben rausschauend. -->
  <div
    class="absolute inset-2 overflow-hidden rounded-2xl shadow-[0_8px_26px_rgba(0,0,0,0.5)]"
    data-testid="voice-stack-back"
  >
    <VoiceChannelView channel={voiceChannel} />
  </div>

  <!-- Tap-Fläche über dem sichtbaren Voice-Peek → zurück zum Voice-Kanal. -->
  <button
    type="button"
    class="absolute inset-x-2 top-2 z-[1]"
    style="height: {PEEK - 8}px;"
    onclick={onReturnToVoice}
    aria-label="Zurück zum Voice-Kanal"
    data-testid="voice-stack-peek"
  ></button>

  <!-- Obere Karte: der Text-Kanal, gestapelt. Endet via Flex-Fluss über dem
       VoiceControlBar-Dock → MessageInput bleibt sichtbar. Kein h-full-Zwang. -->
  <div
    class="bg-bg-chat absolute inset-x-1 bottom-0 overflow-hidden rounded-t-[22px] shadow-[0_-12px_34px_rgba(0,0,0,0.6)]"
    style="top: {PEEK}px; transform: translateY({dragY}px); transition: {dragging
      ? 'none'
      : 'transform 0.2s ease'};"
    data-testid="voice-stack-front"
  >
    <!-- Griff-Leiste: nach unten wischen → zurück zum Voice-Kanal. -->
    <div
      class="absolute inset-x-0 top-0 z-10 flex h-7 touch-none items-center justify-center"
      onpointerdown={onPointerDown}
      onpointermove={onPointerMove}
      onpointerup={onPointerUp}
      onpointercancel={onPointerUp}
      role="button"
      tabindex="-1"
      aria-label="Nach unten wischen für den Voice-Kanal"
    >
      <span class="h-1 w-10 rounded-full bg-white/25"></span>
    </div>
    {@render chat()}
  </div>
</div>
