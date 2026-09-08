<script lang="ts">
  /**
   * Sprachnachricht-Player (P0.3): Play/Pause, Laufzeitbalken, Tempo-Zyklus.
   *
   * Ersetzt die nackten Browser-Controls für `audio/*`-Anhänge — WhatsApp-
   * Optik reicht der Kachel nicht, aber ein eigener Player-Kern ist auch
   * nicht nötig: ein unsichtbares `<audio>` (bleibt mit dem bestehenden
   * Testid laufen), ein Fortschritts-Strich als Klickziel und der
   * Tempo-Zyklus über `playbackRate` (1 → 1.5 → 2 → 1) sind alles.
   *
   * Kein geteilter Zustand mit der Voice-Engine (`voice/audioElements.ts`
   * hängt ihre Elemente unsichtbar an den Body) — hier wird nur DIESER
   * Anhang bedient.
   */
  import PauseIcon from '@lucide/svelte/icons/pause';
  import PlayIcon from '@lucide/svelte/icons/play';
  import { formatiereDauer, naechstesTempo } from '$lib/attachments/aufnahmeKern';
  import { m } from '$lib/paraglide/messages.js';

  let { src }: { src: string | undefined } = $props();

  let audio: HTMLAudioElement | undefined = $state();
  let laeuft = $state(false);
  let tempo = $state(1);
  let position = $state(0);
  let dauer = $state(0);

  function umschalten(): void {
    if (!audio) return;
    if (audio.paused) void audio.play();
    else audio.pause();
  }
</script>

<div
  class="bg-bg-input flex w-64 max-w-full items-center gap-2.5 rounded-xl border border-border px-2.5 py-2"
  data-testid="voice-message-player"
>
  <audio
    bind:this={audio}
    {src}
    preload="metadata"
    class="hidden"
    data-testid="attachment-audio"
    onplay={() => (laeuft = true)}
    onpause={() => (laeuft = false)}
    onended={() => {
      laeuft = false;
      position = 0;
    }}
    ontimeupdate={() => (position = audio?.currentTime ?? 0)}
    onloadedmetadata={() => {
      const a = audio;
      if (!a) return;
      if (a.duration === Infinity) {
        // WebM-Blob-Quirk: die Dauer steht erst, nachdem einmal ans (imaginäre)
        // Ende gesucht wurde — danach liefert durationchange den echten Wert.
        a.currentTime = 1e101;
        a.ontimeupdate = () => {
          a.ontimeupdate = null;
          a.currentTime = 0;
        };
      } else {
        dauer = a.duration;
      }
    }}
    ondurationchange={() => (dauer = audio?.duration ?? 0)}
  ></audio>
  <button
    type="button"
    class="accent-gradient text-primary-foreground flex size-9 shrink-0 items-center justify-center rounded-full"
    onclick={umschalten}
    aria-label={laeuft ? m.audio_player_pause() : m.audio_player_play()}
    data-testid="voice-message-toggle"
  >
    {#if laeuft}<PauseIcon class="size-4" />{:else}<PlayIcon class="size-4" />{/if}
  </button>
  <div class="min-w-0 flex-1">
    <!-- Echtes range-Input statt Div+Klickrechnerei: Tastatur und
         Screenreader kommen gratis mit, der Fortschritt ist reines Styling. -->
    <input
      type="range"
      min="0"
      max={Number.isFinite(dauer) && dauer > 0 ? dauer : 1}
      step="0.1"
      value={position}
      oninput={(e) => {
        if (!audio) return;
        audio.currentTime = Number(e.currentTarget.value);
      }}
      class="accent-primary h-1.5 w-full cursor-pointer"
      aria-label={m.audio_player_position()}
      data-testid="voice-message-track"
    />
    <span class="text-text-muted mt-0.5 block text-2xs leading-none">
      {formatiereDauer(position)} / {formatiereDauer(dauer)}
    </span>
  </div>
  <button
    type="button"
    class="text-text-muted hover:text-text-bright shrink-0 text-xs font-bold tabular-nums"
    onclick={() => {
      tempo = naechstesTempo(tempo);
      if (audio) audio.playbackRate = tempo;
    }}
    aria-label={m.audio_player_speed()}
    data-testid="voice-message-speed"
  >
    {tempo}×
  </button>
</div>
