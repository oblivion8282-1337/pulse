<!--
  TileShell — gemeinsame Chrome für alle Video-Kacheln eines Voice-Channels
  (HQ-Stream, Screenshare, Webcam, Watch Party). Trägt Rahmen, Name-Pille,
  Auto-Fade-/Tap-HUD, Control-Leiste, Stats-Toggle, Fullscreen, Hide, Detach,
  Fokus-Umschalter und die Chat-Slots. Die vier Tile-Komponenten liefern nur
  ihren Video-Inhalt + kind-spezifische Stücke als Snippets.

  HUD-Modi:
   * Fade (Default): Maus-Bewegung zeigt das HUD, nach 2,5 s ohne Aktivität
     fadet es weg. Auf Touch: Tap aufs Video togglet es (kein Zeit-Fade).
   * staticHud (Watch Party): HUD bleibt sichtbar, kein Catcher-Layer — ein
     transparenter Klick-Fänger über dem YouTube/Twitch-iframe würde dessen
     native Player-Controls blockieren.

  compact (Filmstrip-Kachel im Fokus-Modus): kein HUD, das ganze Tile ist ein
  Button der `onToggleFocus` feuert. Wichtig: das `media`-Snippet liegt IMMER
  an derselben Stelle im DOM — `compact` tauscht nur die Chrome darüber, nie
  das Video selbst. Ein Umschalten des Fokus darf die WHEP-/LiveKit-Verbindung
  nicht neu aufbauen.
-->
<script lang="ts">
  import type { Snippet } from 'svelte';
  import { onMount } from 'svelte';
  import RocketIcon from '@lucide/svelte/icons/rocket';
  import MonitorIcon from '@lucide/svelte/icons/monitor';
  import VideoIcon from '@lucide/svelte/icons/video';
  import PlayCircleIcon from '@lucide/svelte/icons/play-circle';
  import Volume2Icon from '@lucide/svelte/icons/volume-2';
  import VolumeXIcon from '@lucide/svelte/icons/volume-x';
  import MaximizeIcon from '@lucide/svelte/icons/maximize';
  import MinimizeIcon from '@lucide/svelte/icons/minimize';
  import MessageSquareIcon from '@lucide/svelte/icons/message-square';
  import ExternalLinkIcon from '@lucide/svelte/icons/external-link';
  import ActivityIcon from '@lucide/svelte/icons/activity';
  import FocusIcon from '@lucide/svelte/icons/focus';
  import LayoutGridIcon from '@lucide/svelte/icons/layout-grid';
  import XIcon from '@lucide/svelte/icons/x';
  import { toggleFullscreen, isDocFullscreen } from '../fullscreen';
  import { VOLUME_BOOST_MAX } from '../volumeBoost';
  import { statsVisible } from '../statsVisible.svelte';
  import { viewport } from '$lib/stores/viewport.svelte';

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
    kind: 'hq' | 'screen' | 'cam' | 'party';
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
    /** HUD erzwungen sichtbar (Verbinde-/Fehler-Overlay, audioBlocked). */
    forceHud?: boolean;
    /** Watch Party: HUD bleibt stehen, kein Klick-Fänger über dem iframe. */
    staticHud?: boolean;
    /** Gesetzt → Lautstärke-Pille wird gerendert (HQ + Screenshare). */
    volume?: number;
    onVolumeChange?: (e: Event) => void;
    onToggleMute?: () => void;
    audioBlocked?: boolean;
    onEnableAudio?: () => void;
    chatOpen?: boolean;
    onToggleChat?: () => void;
    onDetach?: () => void;
    onHide?: () => void;
    /** Filmstrip-Kachel im Fokus-Modus: kein HUD, ganzes Tile = Fokus-Button. */
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
    { hq: RocketIcon, screen: MonitorIcon, cam: VideoIcon, party: PlayCircleIcon }[kind]
  );
  const kindIconColor = $derived(
    kind === 'hq' ? 'text-red-400' : kind === 'party' ? 'text-primary' : ''
  );

  let containerEl = $state<HTMLDivElement | null>(null);
  let isFullscreen = $state(false);
  let hudVisible = $state(true);
  let hideTimer: ReturnType<typeof setTimeout> | null = null;
  const HUD_HIDE_AFTER_MS = 2500;

  // staticHud → immer sichtbar; sonst Fade-/Tap-State. compact → nie.
  let hudEffective = $derived(!compact && (staticHud || hudVisible || forceHud));
  let showStats = $derived(!!stats && statsVisible.on && hudEffective);
  let fadeClass = $derived(
    `transition-opacity duration-300 ${hudEffective ? 'opacity-100' : 'pointer-events-none opacity-0'}`
  );

  // Runde Icon-Buttons: auf Touch ≥44px Trefferfläche (p-3 + size-5), auf
  // Desktop kompakt (p-1.5 + size-3.5).
  const ICON_BTN =
    'flex items-center justify-center rounded-full bg-black/55 p-3 text-white backdrop-blur-sm hover:bg-black/75 md:p-1.5';
  const ICON_SIZE = 'size-5 md:size-3.5';

  function pokeHud(): void {
    if (viewport.isMobile || staticHud || compact) return;
    hudVisible = true;
    if (hideTimer) clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      hudVisible = false;
    }, HUD_HIDE_AFTER_MS);
  }

  function handleCatcherClick(): void {
    if (viewport.isMobile) hudVisible = !hudVisible;
  }
  function handleCatcherDblClick(): void {
    if (!viewport.isMobile) toggleFs();
  }

  function toggleFs(): void {
    toggleFullscreen(containerEl, video);
  }

  onMount(() => {
    if (!viewport.isMobile && !staticHud) pokeHud();
    function onFsChange() {
      isFullscreen = isDocFullscreen();
    }
    document.addEventListener('fullscreenchange', onFsChange);
    return () => {
      document.removeEventListener('fullscreenchange', onFsChange);
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
  <div class="relative flex min-w-0 flex-1 flex-col" onmousemove={pokeHud} role="presentation">
    {@render media()}
    {@render overlay?.()}

    {#if compact}
      <!-- Filmstrip-Kachel: das ganze Tile ist ein Fokus-Button. -->
      <button
        type="button"
        onclick={() => onToggleFocus?.()}
        class="group absolute inset-0 flex items-end"
        aria-label={`${name} in den Fokus holen`}
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
             fängt Tap-to-Toggle (Mobile) + Doppelklick-Fullscreen (Desktop).
             Vor dem HUD im DOM → HUD-Buttons stacken darüber. -->
        <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
        <div
          class="absolute inset-0 cursor-pointer"
          onclick={handleCatcherClick}
          ondblclick={handleCatcherDblClick}
          aria-hidden="true"
          title="Doppelklick für Vollbild"
        ></div>
      {/if}

      <!-- Name-Pille unten links -->
      <div class="absolute bottom-2 left-2 flex items-center gap-1.5 {fadeClass}">
        <div
          class="flex items-center gap-1.5 rounded-full bg-black/55 px-2.5 py-1 text-xs text-white backdrop-blur-sm"
          data-testid={nameTestid}
        >
          <KindIcon class="size-3 {kindIconColor}" />
          <span class="max-w-32 truncate">{name}</span>
        </div>
        {@render nameExtra?.()}
      </div>

      <!-- Diagnose-Stats oben links — nur wenn global eingeschaltet -->
      {#if showStats}
        <div class="absolute left-2 top-2 {fadeClass}">
          {@render stats?.()}
        </div>
      {/if}

      <!-- Hide oben rechts -->
      {#if onHide}
        <button
          type="button"
          onclick={() => onHide?.()}
          class="absolute right-2 top-2 z-10 {ICON_BTN} hover:bg-red-600 {fadeClass}"
          aria-label="Diese Kachel ausblenden"
          title="Ausblenden"
          data-testid={`${testidPrefix}-hide`}
        >
          <XIcon class={ICON_SIZE} />
        </button>
      {/if}

      <!-- Control-Leiste unten rechts. flex-wrap: bei vielen Buttons auf
           schmalen Phones zieht die Leiste eine zweite Zeile nach oben,
           statt aus dem Tile zu laufen. -->
      <div
        class="absolute bottom-2 right-2 flex max-w-[calc(100%-1rem)] flex-wrap items-center justify-end gap-1.5 sm:gap-2 {fadeClass}"
      >
        {#if volume !== undefined}
          <div class="flex items-center gap-1.5 rounded-full bg-black/55 px-2.5 py-1 backdrop-blur-sm">
            <button
              type="button"
              onclick={() => onToggleMute?.()}
              class="flex items-center text-white hover:text-white/70"
              aria-label={volume === 0 ? 'Ton an' : 'Stummschalten'}
              data-testid={`${testidPrefix}-mute`}
            >
              {#if volume === 0}<VolumeXIcon class="size-4 md:size-3" />{:else}<Volume2Icon
                  class="size-4 md:size-3"
                />{/if}
            </button>
            <input
              type="range"
              min="0"
              max={VOLUME_BOOST_MAX}
              value={volume}
              oninput={onVolumeChange}
              class="w-28 accent-white sm:w-20"
              aria-label="Lautstärke"
              data-testid={`${testidPrefix}-volume`}
            />
            <span
              class="w-9 text-right font-mono text-[11px] tabular-nums text-white/85"
              data-testid={`${testidPrefix}-volume-percent`}
            >{volume}%</span>
          </div>
        {/if}
        {#if audioBlocked}
          <button
            type="button"
            onclick={() => onEnableAudio?.()}
            class="flex items-center gap-1.5 rounded-full bg-red-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-red-500 md:py-1"
            data-testid={`${testidPrefix}-unblock-audio`}
          >
            <VolumeXIcon class="size-3.5 md:size-3" />
            Ton aktivieren
          </button>
        {/if}
        {#if stats}
          <button
            type="button"
            onclick={() => statsVisible.toggle()}
            class="{ICON_BTN} {statsVisible.on ? 'ring-2 ring-primary' : ''}"
            aria-label={statsVisible.on ? 'Diagnose-Stats ausblenden' : 'Diagnose-Stats einblenden'}
            aria-pressed={statsVisible.on}
            title="Diagnose-Stats (Codec/FPS/Bitrate)"
            data-testid={`${testidPrefix}-stats-toggle`}
          >
            <ActivityIcon class={ICON_SIZE} />
          </button>
        {/if}
        {#if onToggleChat}
          <button
            type="button"
            onclick={() => onToggleChat?.()}
            class="{ICON_BTN} {chatOpen ? 'ring-2 ring-primary' : ''}"
            aria-label={chatOpen ? 'Live-Chat schließen' : 'Live-Chat öffnen'}
            aria-pressed={chatOpen}
            title="Live-Chat"
            data-testid={`${testidPrefix}-chat-toggle`}
          >
            <MessageSquareIcon class={ICON_SIZE} />
          </button>
        {/if}
        {@render controlsExtra?.()}
        {#if onDetach && !isFullscreen && !viewport.isMobile}
          <button
            type="button"
            onclick={() => onDetach?.()}
            class={ICON_BTN}
            aria-label="In eigenem Fenster öffnen"
            title="In eigenem Fenster öffnen"
            data-testid={`${testidPrefix}-detach`}
          >
            <ExternalLinkIcon class={ICON_SIZE} />
          </button>
        {/if}
        {#if onToggleFocus}
          <button
            type="button"
            onclick={() => onToggleFocus?.()}
            class={ICON_BTN}
            aria-label={focused ? 'Zurück zum Raster' : 'In den Fokus holen'}
            title={focused ? 'Zurück zum Raster' : 'In den Fokus'}
            data-testid={`${testidPrefix}-focus-toggle`}
          >
            {#if focused}<LayoutGridIcon class={ICON_SIZE} />{:else}<FocusIcon
                class={ICON_SIZE}
              />{/if}
          </button>
        {/if}
        <button
          type="button"
          onclick={toggleFs}
          class={ICON_BTN}
          aria-label={isFullscreen ? 'Vollbild verlassen' : 'Vollbild'}
          title={isFullscreen ? 'Vollbild verlassen' : 'Vollbild'}
          data-testid={`${testidPrefix}-fullscreen`}
        >
          {#if isFullscreen}<MinimizeIcon class={ICON_SIZE} />{:else}<MaximizeIcon
              class={ICON_SIZE}
            />{/if}
        </button>
      </div>

      {#if isFullscreen && chatOpen}
        {@render chatOverlay?.()}
      {/if}
    {/if}
  </div>

  {#if !compact && chatOpen && !isFullscreen}
    {@render chatPanel?.()}
  {/if}
</div>
