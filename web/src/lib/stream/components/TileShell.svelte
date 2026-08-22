<!--
  TileShell — gemeinsame Chrome für alle Video-Kacheln eines Voice-Channels
  (HQ-Stream, Screenshare, Webcam, Watch Party). Trägt Rahmen, Video-Fläche,
  die Steuerleiste (`TileDock`), Stats-Overlay, Fullscreen, Detach/Hide
  und die Chat-Slots. Die vier Tile-Komponenten liefern nur ihren Video-Inhalt
  + kind-spezifische Stücke als Snippets.

  Steuerung (Player-Stil): die Buttons liegen NICHT mehr auf dem Video, sondern
  in einer soliden Leiste DARUNTER (`TileDock overlay=false`). Nur im Vollbild
  wird die Leiste zum fadenden Overlay über dem unteren Bildrand
  (`overlay=true`) — immersiv, taucht bei Maus-/Tap-Aktivität auf und fadet nach
  2,5 s weg. Das gilt für alle Kacheln inkl. Watch-Party. Der transparente
  Klick-Fänger (Doppelklick → Vollbild) liegt nur über <video>-Kacheln, NICHT
  über der Watch-Party (kind 'party'): dort ist das Medium ein iframe, dessen
  native Controls der Fänger sonst blockieren würde.
-->
<script lang="ts">
  import type { Snippet } from 'svelte';
  import { onMount } from 'svelte';
  import RocketIcon from '@lucide/svelte/icons/rocket';
  import MonitorIcon from '@lucide/svelte/icons/monitor';
  import VideoIcon from '@lucide/svelte/icons/video';
  import ClapperboardIcon from '@lucide/svelte/icons/clapperboard';
  import { m } from '$lib/paraglide/messages.js';
  import { toggleFullscreen } from '../fullscreen';
  import { statsVisible } from '../statsVisible.svelte';
  import { viewport } from '$lib/stores/viewport.svelte';
  import TileDock from './TileDock.svelte';
  import type { TileKind } from '../openedTiles.svelte';

  let {
    kind,
    containerTestid,
    testidPrefix,
    identity,
    name,
    nameTestid,
    video = null,
    forceHud = false,
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
    onDetach,
    detachLabel,
    hideDock = false,
    onHide,
    media,
    overlay,
    stats,
    nameExtra,
    controlsExtra,
    chatPanel,
    chatOverlay,
    queuePanel
  }: {
    kind: TileKind;
    /** data-testid des äußeren Containers (kind-spezifisch, kein Schema). */
    containerTestid: string;
    /** Prefix für alle inneren Testids: `${prefix}-mute`, `-fullscreen`, … */
    testidPrefix: string;
    /** Optionales data-identity am Container (Screenshare/Webcam-LiveKit-ID). */
    identity?: string;
    name: string;
    nameTestid?: string;
    /** <video>-Element für den iOS-Fullscreen-Fallback. iframe → null. */
    video?: HTMLVideoElement | null;
    /** HUD im Vollbild erzwungen sichtbar (Verbinde-/Fehler-Overlay). */
    forceHud?: boolean;
    /** Gesetzt → Lautstärke-Regler wird gerendert (HQ + Screenshare). */
    volume?: number;
    /** Obergrenze des Reglers. Vorgabe = Verstärkung bis 200 %; Quellen ohne
     * Verstärkungsgriff (Watch-Party-Kachel) geben 100 vor. */
    volumeMax?: number;
    onVolumeChange?: (e: Event) => void;
    onToggleMute?: () => void;
    audioBlocked?: boolean;
    onEnableAudio?: () => void;
    chatOpen?: boolean;
    onToggleChat?: () => void;
    /** Watch Party: gleicher Seitenpanel-Slot wie der Chat, aber für die
     *  Warteschlange. Chat + Queue schliessen sich gegenseitig aus (der Aufrufer
     *  regelt das), es liegt also immer nur eins rechts. */
    queueOpen?: boolean;
    onToggleQueue?: () => void;
    onDetach?: () => void;
    /** Beschriftung des Abkoppel-Knopfs (s. TileDock). */
    detachLabel?: string;
    /** Steuerleiste ganz weglassen. Der HQ-Stream setzt das, sobald sein Bild
     *  im eigenen Player-Fenster laeuft: dessen Leiste ist dann die einzige
     *  Bedienung, zwei uebereinander waeren nur verwirrend. */
    hideDock?: boolean;
    onHide?: () => void;
    media: Snippet;
    overlay?: Snippet;
    stats?: Snippet;
    nameExtra?: Snippet;
    controlsExtra?: Snippet;
    chatPanel?: Snippet;
    chatOverlay?: Snippet;
    queuePanel?: Snippet;
  } = $props();

  const KindIcon = $derived(
    { hq: RocketIcon, screen: MonitorIcon, cam: VideoIcon, party: ClapperboardIcon }[kind]
  );
  const kindIconColor = $derived(
    kind === 'hq' ? 'text-red-400' : kind === 'party' ? 'text-primary' : ''
  );

  let containerEl = $state<HTMLDivElement | null>(null);
  let leftColEl = $state<HTMLDivElement | null>(null);
  let isFullscreen = $state(false);
  // Nur im Vollbild relevant: die Overlay-Leiste fadet nach Inaktivität.
  let hudVisible = $state(true);
  let hideTimer: ReturnType<typeof setTimeout> | null = null;
  const HUD_HIDE_AFTER_MS = 2500;
  // Reicht die Kachelbreite für alle Controls inline? Sonst kollabiert TileDock
  // in ein ⋯-Menü. Im Vollbild ist die Kachel groß → immer wide.
  let dockWide = $state(true);
  const DOCK_WIDE_MIN = 340;

  const hudEffective = $derived(hudVisible || forceHud);
  const fadeClass = $derived(
    `transition-opacity duration-300 ${hudEffective ? 'opacity-100' : 'pointer-events-none opacity-0'}`
  );
  // Stats-Pille (Diagnose) oben links: im Tile immer sichtbar wenn eingeschaltet,
  // im Vollbild an den Fade gekoppelt.
  const showStats = $derived(!!stats && statsVisible.on && (!isFullscreen || hudEffective));
  // Detach gibt's nicht im Vollbild und nicht auf Mobile.
  const showDetach = $derived(!!onDetach && !isFullscreen && !viewport.isMobile);

  function pokeHud(): void {
    if (!isFullscreen) return;
    hudVisible = true;
    if (hideTimer) clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      hudVisible = false;
    }, HUD_HIDE_AFTER_MS);
  }

  function handleCatcherClick(): void {
    // Im Vollbild auf Touch: Tap blendet die Overlay-Leiste ein/aus.
    if (viewport.isMobile && isFullscreen) hudVisible = !hudVisible;
  }
  function handleCatcherDblClick(): void {
    if (!viewport.isMobile) toggleFs();
  }

  function toggleFs(): void {
    toggleFullscreen(containerEl, video);
  }

  const dockProps = $derived({
    kindIcon: KindIcon,
    kindIconColor,
    name,
    nameTestid,
    nameExtra,
    testidPrefix,
    volume,
    volumeMax,
    onVolumeChange,
    onToggleMute,
    audioBlocked,
    onEnableAudio,
    hasStats: !!stats,
    chatOpen,
    onToggleChat,
    queueOpen,
    onToggleQueue,
    controlsExtra,
    onDetach,
    showDetach,
    detachLabel,
    isFullscreen,
    onToggleFullscreen: toggleFs,
    onHide
  });

  onMount(() => {
    function onFsChange() {
      isFullscreen = !!document.fullscreenElement;
      if (isFullscreen) {
        // Vollbild = große Kachel → sofort wide, sonst blitzt für einen Frame
        // das ⋯-Menü auf, bevor der ResizeObserver nachzieht.
        dockWide = true;
        pokeHud();
      } else {
        hudVisible = true;
        if (hideTimer) clearTimeout(hideTimer);
      }
    }
    document.addEventListener('fullscreenchange', onFsChange);

    let ro: ResizeObserver | null = null;
    if (leftColEl) {
      ro = new ResizeObserver((entries) => {
        const w = entries[0]?.contentRect.width ?? 0;
        dockWide = w >= DOCK_WIDE_MIN;
      });
      ro.observe(leftColEl);
    }

    return () => {
      document.removeEventListener('fullscreenchange', onFsChange);
      ro?.disconnect();
      if (hideTimer) clearTimeout(hideTimer);
    };
  });
</script>

<div
  bind:this={containerEl}
  class="bg-bg-chat flex h-full overflow-hidden {isFullscreen
    ? 'rounded-none border-0'
    : 'rounded-2xl border border-border'}"
  data-testid={containerTestid}
  data-identity={identity}
>
  <div bind:this={leftColEl} class="flex min-w-0 flex-1 flex-col">
    <div class="relative flex min-h-0 flex-1 flex-col" onmousemove={pokeHud} role="presentation">
      {@render media()}
      {@render overlay?.()}

      {#if kind !== 'party'}
        <!-- Transparenter Klick-Fänger über dem Video (nicht über iframes!):
             Doppelklick → Fullscreen (Desktop), Tap → Leiste toggeln nur im
             Vollbild (Mobile). Die Watch-Party (kind 'party') nutzt ein
             iframe — dort würde der Fänger die nativen Controls blockieren. -->
        <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
        <div
          class="absolute inset-0 cursor-pointer"
          onclick={handleCatcherClick}
          ondblclick={handleCatcherDblClick}
          aria-hidden="true"
          title={isFullscreen ? undefined : m.tile_shell_dblclick_fullscreen()}
        ></div>
      {/if}

      <!-- Diagnose-Stats oben links — nur wenn global eingeschaltet -->
      {#if showStats}
        <div class="absolute left-2 top-2 {isFullscreen ? fadeClass : ''}">
          {@render stats?.()}
        </div>
      {/if}

      <!-- Vollbild: Leiste als fadendes Overlay über dem unteren Bildrand,
           das nach Inaktivität (HUD_HIDE_AFTER_MS) ausgeblendet wird. -->
      {#if isFullscreen && !hideDock}
        <div
          class="absolute inset-x-0 bottom-0 z-10 bg-gradient-to-t from-black/85 via-black/45 to-transparent pt-10 {fadeClass}"
        >
          <TileDock {...dockProps} overlay wide={dockWide} />
        </div>
      {/if}

      {#if isFullscreen && chatOpen}
        {@render chatOverlay?.()}
      {/if}
      {#if chatOpen && !isFullscreen && viewport.isMobile}
        <!-- Mobile: Chat als Vollflächen-Overlay statt Seitenpanel. -->
        <div class="absolute inset-0 z-20">
          {@render chatPanel?.()}
        </div>
      {/if}
      {#if queueOpen && !isFullscreen && viewport.isMobile}
        <div class="absolute inset-0 z-20">
          {@render queuePanel?.()}
        </div>
      {/if}
    </div>

    <!-- Solide Steuerleiste UNTER dem Video, nur außerhalb des Vollbilds.
         Im Vollbild übernimmt das fadende Overlay oben. -->
    {#if !isFullscreen && !hideDock}
      <div class="bg-bg-panel border-t border-border">
        <TileDock {...dockProps} overlay={false} wide={dockWide} />
      </div>
    {/if}
  </div>

  {#if chatOpen && !isFullscreen && !viewport.isMobile}
    {@render chatPanel?.()}
  {/if}
  {#if queueOpen && !isFullscreen && !viewport.isMobile}
    {@render queuePanel?.()}
  {/if}
</div>
