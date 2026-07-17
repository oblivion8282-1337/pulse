<!--
  TileShell — gemeinsame Chrome für alle Video-Kacheln eines Voice-Channels
  (HQ-Stream, Screenshare, Webcam, Watch Party). Trägt Rahmen, Video-Fläche,
  die Steuerleiste (`TileDock`), Stats-Overlay, Fullscreen, Detach/Hide/Fokus
  und die Chat-Slots. Die vier Tile-Komponenten liefern nur ihren Video-Inhalt
  + kind-spezifische Stücke als Snippets.

  Steuerung (Player-Stil): die Buttons liegen NICHT mehr auf dem Video, sondern
  in einer soliden Leiste DARUNTER (`TileDock overlay=false`). Nur im Vollbild
  wird die Leiste zum fadenden Overlay über dem unteren Bildrand
  (`overlay=true`) — immersiv, taucht bei Maus-/Tap-Aktivität auf und fadet nach
  2,5 s weg. Für die Watch-Party (iframe) ist die Leiste-darunter ideal: der
  alte Klick-Fänger über dem iframe (`staticHud`) entfällt, weil nichts mehr
  über dem Video liegt.

  compact (Filmstrip-Kachel im Fokus-Modus): keine Leiste, das ganze Tile ist
  ein Button der `onToggleFocus` feuert. Das `media`-Snippet liegt IMMER an
  derselben Stelle im DOM — `compact`/Fokus-Wechsel tauscht nur die Chrome
  darüber, nie das Video selbst (sonst WHEP-/LiveKit-Reconnect).
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
    staticHud = false,
    volume,
    onVolumeChange,
    onToggleMute,
    audioBlocked = false,
    onEnableAudio,
    chatOpen = false,
    onToggleChat,
    onDetach,
    onHide,
    compact = false,
    focused = false,
    onToggleFocus,
    media,
    overlay,
    stats,
    nameExtra,
    controlsExtra,
    chatPanel,
    chatOverlay
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
    /** Watch Party: Leiste im Vollbild dauerhaft sichtbar (iframe-Controls). */
    staticHud?: boolean;
    /** Gesetzt → Lautstärke-Regler wird gerendert (HQ + Screenshare). */
    volume?: number;
    onVolumeChange?: (e: Event) => void;
    onToggleMute?: () => void;
    audioBlocked?: boolean;
    onEnableAudio?: () => void;
    chatOpen?: boolean;
    onToggleChat?: () => void;
    onDetach?: () => void;
    onHide?: () => void;
    /** Filmstrip-Kachel im Fokus-Modus: keine Leiste, ganzes Tile = Fokus. */
    compact?: boolean;
    /** Diese Kachel ist die fokussierte (große) im Fokus-Modus. */
    focused?: boolean;
    /** Gesetzt → Fokus-Umschalter sichtbar. compact: ganzes Tile feuert ihn. */
    onToggleFocus?: () => void;
    media: Snippet;
    overlay?: Snippet;
    stats?: Snippet;
    nameExtra?: Snippet;
    controlsExtra?: Snippet;
    chatPanel?: Snippet;
    chatOverlay?: Snippet;
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

  const hudEffective = $derived(staticHud || hudVisible || forceHud);
  const fadeClass = $derived(
    `transition-opacity duration-300 ${hudEffective ? 'opacity-100' : 'pointer-events-none opacity-0'}`
  );
  // Stats-Pille (Diagnose) oben links: im Tile immer sichtbar wenn eingeschaltet,
  // im Vollbild an den Fade gekoppelt.
  const showStats = $derived(!!stats && statsVisible.on && (!isFullscreen || hudEffective));
  // Detach gibt's nicht im Vollbild und nicht auf Mobile.
  const showDetach = $derived(!!onDetach && !isFullscreen && !viewport.isMobile);

  function pokeHud(): void {
    if (!isFullscreen || compact || staticHud) return;
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
    onVolumeChange,
    onToggleMute,
    audioBlocked,
    onEnableAudio,
    hasStats: !!stats,
    chatOpen,
    onToggleChat,
    controlsExtra,
    onDetach,
    showDetach,
    onToggleFocus,
    focused,
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
  class="bg-bg-chat flex h-full overflow-hidden rounded-2xl border border-border"
  data-testid={containerTestid}
  data-identity={identity}
>
  <div bind:this={leftColEl} class="flex min-w-0 flex-1 flex-col">
    <div class="relative flex min-h-0 flex-1 flex-col" onmousemove={pokeHud} role="presentation">
      {@render media()}
      {@render overlay?.()}

      {#if compact}
        <!-- Filmstrip-Kachel: das ganze Tile ist ein Fokus-Button. -->
        <button
          type="button"
          onclick={() => onToggleFocus?.()}
          class="group absolute inset-0 flex items-end"
          aria-label={m.tile_shell_focus_tile({ name })}
          data-testid={`${testidPrefix}-focus`}
        >
          <div class="absolute inset-0 bg-black/30 transition-colors group-hover:bg-black/10"></div>
          <div
            class="relative m-1 flex items-center gap-1 rounded-full bg-black/65 px-2 py-0.5 text-[10px] text-white"
          >
            <KindIcon class="size-2.5 {kindIconColor}" />
            <span class="max-w-24 truncate">{name}</span>
          </div>
        </button>
      {:else}
        {#if !staticHud}
          <!-- Transparenter Klick-Fänger über dem Video (nicht über iframes!):
               Doppelklick → Fullscreen (Desktop), Tap → Leiste toggeln nur im
               Vollbild (Mobile). -->
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

        <!-- Vollbild: Leiste als fadendes Overlay über dem unteren Bildrand.
             NICHT bei der Watch-Party (staticHud) — dort würde das Overlay die
             nativen iframe-Controls verdecken; die kriegt stattdessen die
             solide Leiste darunter (siehe unten). -->
        {#if isFullscreen && !staticHud}
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
      {/if}
    </div>

    <!-- Solide Steuerleiste UNTER dem Video. Normalerweise nur außerhalb des
         Vollbilds — aber die Watch-Party (staticHud) behält sie auch im
         Vollbild solide darunter, damit das iframe (leicht kleiner) seine
         nativen Controls frei darüber behält. -->
    {#if !compact && (!isFullscreen || staticHud)}
      <div class="bg-bg-panel border-t border-border">
        <TileDock {...dockProps} overlay={false} wide={dockWide} />
      </div>
    {/if}
  </div>

  {#if !compact && chatOpen && !isFullscreen && !viewport.isMobile}
    {@render chatPanel?.()}
  {/if}
</div>
