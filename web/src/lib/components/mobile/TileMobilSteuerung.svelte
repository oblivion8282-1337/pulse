<!--
  TileMobilSteuerung — die schwebenden Bedienelemente einer Video-Kachel am
  Handy. Sie ERSETZEN dort die Leiste `TileDock`, die unter dem Bild zu viel
  Höhe kosten würde.

  **Ersetzen heisst: alles, was der Dock kann, muss hier erreichbar sein.**
  Die erste Fassung liess nur Schliessen, Vollbild und Lautstärke übrig — mit
  dem Rest verschwanden am Telefon auch der Stream-Chat, die Watch-Party-
  Warteschlange, die Stummschaltung und der Knopf „Ton freischalten". Der war
  der schlimmste Verlust: blockiert Chromium die Wiedergabe, ist er die einzige
  Abhilfe, und ohne ihn bleibt der Stream für immer stumm.

  Eine Komponente für beide Lagen (Kachel und Vollbild) statt zweier Zweige:
  die Knöpfe sind dieselben, nur das Ausblenden nach Ruhe (`fadeClass`) und der
  Vollbild-Ausstieg unterscheiden sich.
-->
<script lang="ts">
  import ChevronLeftIcon from '@lucide/svelte/icons/chevron-left';
  import MaximizeIcon from '@lucide/svelte/icons/maximize';
  import MinusIcon from '@lucide/svelte/icons/minus';
  import PlusIcon from '@lucide/svelte/icons/plus';
  import Volume2Icon from '@lucide/svelte/icons/volume-2';
  import VolumeXIcon from '@lucide/svelte/icons/volume-x';
  import MessageSquareIcon from '@lucide/svelte/icons/message-square';
  import ListVideoIcon from '@lucide/svelte/icons/list-video';
  import { m } from '$lib/paraglide/messages.js';

  let {
    testidPrefix,
    isFullscreen = false,
    /** Ausblend-Klasse im Vollbild; in der Kachel leer (nichts fadet). */
    fadeClass = '',
    /** Vollbild-Ausstieg als Pfeil oben links. Im Querformat ist das Vollbild
     *  automatisch und wird automatisch verlassen — dort bewusst aus. */
    zeigeVollbildAus = false,
    volume,
    volumeMax,
    onVolumeChange,
    onToggleMute,
    audioBlocked = false,
    onEnableAudio,
    chatOpen = false,
    onToggleChat,
    queueOpen = false,
    onToggleQueue,
    onHide,
    onToggleFullscreen
  }: {
    testidPrefix: string;
    isFullscreen?: boolean;
    fadeClass?: string;
    zeigeVollbildAus?: boolean;
    volume?: number;
    volumeMax?: number;
    onVolumeChange?: (e: Event | number) => void;
    onToggleMute?: () => void;
    audioBlocked?: boolean;
    onEnableAudio?: () => void;
    chatOpen?: boolean;
    onToggleChat?: () => void;
    queueOpen?: boolean;
    onToggleQueue?: () => void;
    onHide?: () => void;
    onToggleFullscreen: () => void;
  } = $props();

  // Am Handy wird die Lautstärke IMMER auf 5er gerastert — angezeigt UND
  // gesetzt: ein Wert wie 87 (vom Regler des Rechners mitgenommen) zeigt hier
  // 85, der nächste Tipp geht auf 90.
  const gerastert = $derived(volume === undefined ? 0 : Math.round(volume / 5) * 5);
  const hatLautstaerke = $derived(onVolumeChange !== undefined && volume !== undefined);

  const RUND =
    'flex size-10 items-center justify-center rounded-full bg-black/45 text-white backdrop-blur-sm transition-colors hover:bg-black/65';
</script>

<!-- Oben links: zurück (Kachel schliessen) beziehungsweise Vollbild verlassen.
     Beides ist derselbe Platz, weil es dieselbe Geste ist: eine Ebene zurück. -->
{#if isFullscreen ? zeigeVollbildAus : !!onHide}
  <button
    type="button"
    class="absolute top-2 left-2 z-30 {RUND} {fadeClass}"
    onclick={() => (isFullscreen ? onToggleFullscreen() : onHide?.())}
    aria-label={isFullscreen ? m.tile_shell_fullscreen_exit() : m.tile_shell_hide_tile()}
    data-pip-hide
    data-testid={isFullscreen
      ? `${testidPrefix}-fullscreen-exit-float`
      : `${testidPrefix}-close-float`}
  >
    <ChevronLeftIcon class="size-5" />
  </button>
{/if}

<!-- Oben rechts: die Seitenpanel-Schalter. Sie sind die einzige Möglichkeit,
     die Overlays für Chat und Warteschlange am Telefon zu öffnen — ohne sie
     ist deren Markup toter Code. -->
{#if onToggleChat || onToggleQueue}
  <div class="absolute top-2 right-2 z-30 flex items-center gap-2 {fadeClass}">
    {#if onToggleQueue}
      <button
        type="button"
        class="{RUND} {queueOpen ? '!text-primary' : ''}"
        onclick={onToggleQueue}
        aria-label={queueOpen ? m.watch_queue_close() : m.watch_queue_open()}
        data-pip-hide
        data-testid={`${testidPrefix}-queue-float`}
      >
        <ListVideoIcon class="size-5" />
      </button>
    {/if}
    {#if onToggleChat}
      <button
        type="button"
        class="{RUND} {chatOpen ? '!text-primary' : ''}"
        onclick={onToggleChat}
        aria-label={chatOpen ? m.tile_shell_chat_close() : m.tile_shell_chat_open()}
        data-pip-hide
        data-testid={`${testidPrefix}-chat-float`}
      >
        <MessageSquareIcon class="size-5" />
      </button>
    {/if}
  </div>
{/if}

<!-- Unten rechts: Vollbild. Im Vollbild selbst führt der Pfeil oben links
     hinaus, hier bliebe der Knopf ohne Aufgabe. -->
{#if !isFullscreen}
  <button
    type="button"
    class="absolute right-2 bottom-2 z-20 {RUND}"
    onclick={onToggleFullscreen}
    aria-label={m.tile_shell_fullscreen_enter()}
    data-pip-hide
    data-testid={`${testidPrefix}-fullscreen-float`}
  >
    <MaximizeIcon class="size-5" />
  </button>
{/if}

<!-- Unten links: Lautstärke in 5er-Schritten statt Regler — ein ferner Daumen
     trifft zwei Knöpfe sicherer als einen Schieber. Die Stummschaltung sitzt
     als Lautsprecher IN der Pille: sie ist der einzige Weg zurück, wenn man
     die Lautstärke auf 0 gezogen hat. -->
{#if hatLautstaerke}
  <div class="absolute bottom-2 left-2 z-30 {fadeClass}">
    <div
      class="flex items-center gap-0.5 rounded-full bg-black/45 px-1 text-white backdrop-blur-sm"
      data-pip-hide
      data-testid={`${testidPrefix}-volume-stepper`}
    >
      {#if onToggleMute}
        <button
          type="button"
          class="flex size-9 items-center justify-center rounded-full transition-colors hover:bg-black/65"
          onclick={onToggleMute}
          aria-label={gerastert === 0 ? m.tile_shell_unmute() : m.tile_shell_mute()}
          data-testid={`${testidPrefix}-mute-float`}
        >
          {#if gerastert === 0}
            <VolumeXIcon class="size-4" />
          {:else}
            <Volume2Icon class="size-4" />
          {/if}
        </button>
      {/if}
      <button
        type="button"
        class="flex size-9 items-center justify-center rounded-full transition-colors hover:bg-black/65"
        onclick={() => onVolumeChange?.(Math.max(0, gerastert - 5))}
        aria-label={m.tile_shell_volume_down()}
        data-testid={`${testidPrefix}-volume-down`}
      >
        <MinusIcon class="size-4" />
      </button>
      <span
        class="w-10 text-center font-mono text-xs tabular-nums"
        data-testid={`${testidPrefix}-volume-value`}>{gerastert}%</span
      >
      <button
        type="button"
        class="flex size-9 items-center justify-center rounded-full transition-colors hover:bg-black/65"
        onclick={() => onVolumeChange?.(Math.min(volumeMax ?? 200, gerastert + 5))}
        aria-label={m.tile_shell_volume_up()}
        data-testid={`${testidPrefix}-volume-up`}
      >
        <PlusIcon class="size-4" />
      </button>
    </div>
  </div>
{/if}

<!-- Ton freigeben: Chromium blockt die Wiedergabe ohne Nutzergeste. Der Knopf
     steht MITTIG und fadet NICHT mit — er ist kein Komfort, sondern die
     einzige Abhilfe, und ein ausgeblendeter Knopf wäre so gut wie keiner. -->
{#if audioBlocked && onEnableAudio}
  <button
    type="button"
    class="absolute top-1/2 left-1/2 z-40 flex -translate-x-1/2 -translate-y-1/2 items-center gap-2 rounded-full bg-black/70 px-4 py-2.5 text-sm font-semibold text-white backdrop-blur-sm transition-colors hover:bg-black/85"
    onclick={onEnableAudio}
    data-pip-hide
    data-testid={`${testidPrefix}-enable-audio-float`}
  >
    <VolumeXIcon class="size-4" />
    {m.tile_shell_enable_audio()}
  </button>
{/if}
