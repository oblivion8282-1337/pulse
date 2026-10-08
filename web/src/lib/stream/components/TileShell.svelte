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
  import { onMount } from 'svelte';
  import RocketIcon from '@lucide/svelte/icons/rocket';
  import MonitorIcon from '@lucide/svelte/icons/monitor';
  import VideoIcon from '@lucide/svelte/icons/video';
  import ClapperboardIcon from '@lucide/svelte/icons/clapperboard';
  import { m } from '$lib/paraglide/messages.js';
  import { eigenesVollbildNoetig, toggleFullscreen } from '../fullscreen';
  import { statsVisible } from '../statsVisible.svelte';
  import TileDock from './TileDock.svelte';
  import TileMobilSteuerung from '$lib/components/mobile/TileMobilSteuerung.svelte';
  import type { TileShellProps } from './tileShellProps';

  let {
    kind,
    /** Handy-Klasse? Vom Mount-Punkt (Route/Hintergrund-Host) hereingereicht
     *  — s. tileShellProps. Ohne sie fragte die Kachel selbst den Viewport. */
    handy,
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
    reaktionenAn,
    onToggleReaktionen,
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
  }: TileShellProps = $props();

  // Handy quer: die Kachel springt automatisch ins Element-Vollbild (Kippen).
  // **Seit der Geräteklassen-Vereinheitlichung (2026-09-04) tot:** der alte
  // Ausdruck `istHandy && !isMobile` verglich dieselbe Klasse mit ihrer
  // eigenen Negation und war damit immer falsch — das hier erhält dieses
  // Verhalten bit-identisch (false), eine Wiederbelebung fürs Tablet wäre
  // eine Verhaltensänderung und gehört nicht in die Geräte-Trennung.
  const quer = false;
  const KindIcon = $derived(
    { hq: RocketIcon, screen: MonitorIcon, cam: VideoIcon, party: ClapperboardIcon }[kind]
  );
  const kindIconColor = $derived(
    kind === 'hq' ? 'text-red-400' : kind === 'party' ? 'text-primary' : ''
  );

  let containerEl = $state<HTMLDivElement | null>(null);

  // Mobil wird ein krummer Lautstärke-Wert (z.B. 87, vom Desktop-Regler
  // mitgenommen) AKTIV auf den nächsten 5er pegelt — nicht nur angezeigt.
  // Rundet kaufmännisch (87 → 85, 88 → 90); nach dem Pegeln steht der Wert
  // im Raster und der Effekt beruhigt sich.
  $effect(() => {
    if (!handy || volume === undefined || !onVolumeChange) return;
    if (Number.isInteger(volume / 5)) return;
    onVolumeChange(Math.round(volume / 5) * 5);
  });
  let leftColEl = $state<HTMLDivElement | null>(null);
  // Vollbild hat ZWEI Quellen, und am Telefon ist nur die zweite erreichbar.
  // `docVollbild` = echtes Element-Vollbild über die Fullscreen-API (alles
  // außer iPhone). `eigenesVollbild` = selbst gebaut, weil es dort keine
  // Fullscreen-API für <div> gibt; der frühere Weg (Apples Systemplayer über
  // `webkitEnterFullscreen`) nahm dem Nutzer den getrennten Lautstärkeregler
  // weg — Begründung im Kopf von `stream/fullscreen.ts`.
  let docVollbild = $state(false);
  let eigenesVollbild = $state(false);
  const isFullscreen = $derived(docVollbild || eigenesVollbild);
  // Nur im Vollbild relevant: die Overlay-Leiste fadet nach Inaktivität.
  let hudVisible = $state(true);
  let hideTimer: ReturnType<typeof setTimeout> | null = null;
  const HUD_HIDE_AFTER_MS = 3000;
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
  const showDetach = $derived(!!onDetach && !isFullscreen && !handy);

  function pokeHud(): void {
    if (!isFullscreen) return;
    hudVisible = true;
    if (hideTimer) clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      hudVisible = false;
    }, HUD_HIDE_AFTER_MS);
  }

  // Beim Betreten des Vollbilds — echtes wie selbst gebautes — zwei Handgriffe:
  // Vollbild = große Kachel → sofort `wide`, sonst blitzt für einen Frame das
  // ⋯-Menü auf, bevor der ResizeObserver nachzieht; und der Ausblend-Timer der
  // schwebenden Steuerung startet.
  function vollbildBetreten(): void {
    dockWide = true;
    pokeHud();
  }

  function handleCatcherClick(): void {
    // Im Vollbild auf Touch: Tap blendet die schwebende Steuerung ein und
    // startet den Ausblend-Timer neu (kein Toggle mehr — Nutzerwunsch: nach
    // HUD_HIDE_AFTER_MS ohne Tap weg, Tap zeigt sie wieder).
    if (handy && isFullscreen) pokeHud();
  }
  function handleCatcherDblClick(): void {
    if (!handy) toggleFs();
  }

  function toggleFs(): void {
    if (eigenesVollbild) {
      eigenesVollbild = false;
      return;
    }
    if (eigenesVollbildNoetig(containerEl)) {
      eigenesVollbild = true;
      vollbildBetreten();
      return;
    }
    toggleFullscreen(containerEl, video);
  }

  // Auto-Vollbild beim Kippen (Nutzerwunsch 2026-08-26): Handy quer + Video-
  // Kachel offen → DIREKT ins Element-Vollbild, ohne vorheriges Tippen auf
  // das Vollbild-Symbol. Zurück im Hochformat wird es automatisch verlassen.
  // Schlägt die Anforderung fehl (WebView verlangt eine Nutzer-Geste), bleibt
  // das Layout-Vollbild von kanalQuerStream als Fallback — Steuerung dann über
  // die schwebenden Knöpfe wie bisher.
  //
  // **Der Effekt darf `isFullscreen` NICHT lesen.** Täte er es, wäre das
  // Vollbild unverlassbar: Esc setzt `isFullscreen = false`, die Abhängigkeit
  // ändert sich, der Effekt fordert sofort wieder an. Ausgelöst wird deshalb
  // allein der ÜBERGANG ins Querformat, gemerkt in `warQuer` — und ein einmal
  // verlassenes Vollbild bleibt verlassen, bis das Gerät wieder hoch und
  // erneut quer gedreht wird.
  let warQuer = false;
  $effect(() => {
    if (kind === 'party') return; // iframe: kein requestFullscreen auf dem Div
    if (quer && !warQuer && containerEl) {
      containerEl.requestFullscreen?.().catch(() => {
        /* Fallback: Layout-Vollbild übernimmt */
      });
    }
    warQuer = quer;
  });
  // Zurück im Hochformat: Vollbild verlassen. Gilt für jedes Gerät, auf dem
  // der Kipp-Effekt oben greifen konnte — die Bedingung ist deshalb das
  // Gegenstück zu `quer` und nicht bloss `isMobile` (auf einem breiten
  // Handy-Querformat wäre `isMobile` schon vorher falsch gewesen und das
  // Vollbild liesse sich gar nicht mehr automatisch schliessen).
  $effect(() => {
    if (!quer && isFullscreen && warQuer) {
      document.exitFullscreen?.().catch(() => {});
    }
  });
  // **Dieser Effekt kann heute nicht laufen** — `quer` ist seit dem 2026-09-04
  // die Konstante `false` (Begründung an der Zeile selbst), `warQuer` bekommt
  // nur `quer` zugewiesen. Hier steht deshalb bewusst KEIN
  // `eigenesVollbild = false`: es sähe nach einem automatischen Verlassen des
  // selbst gebauten Vollbilds beim Zurückdrehen aus, das es nicht gibt.
  // Verlassen wird es über `toggleFs` — am Telefon der Pfeil oben links, den
  // `TileMobilSteuerung` im Vollbild immer zeigt (`zeigeVollbildAus`).

  // Rahmen fällt im Vollbild weg; das selbst gebaute Vollbild muss sich die
  // Fläche zusätzlich selbst nehmen (`fixed inset-0`) — s. `eigenesVollbild`.
  //
  // `data-eigenes-vollbild` ist der Haken für das Eckfenster: navigiert der
  // Nutzer aus dem Kanal, während das selbst gebaute Vollbild an ist, wird die
  // Kachel vom Hintergrund-Host zum PiP-Fenster — das `fixed inset-0` bliebe
  // aber stehen und deckte den ganzen Bildschirm zu. `app.css` nimmt es im
  // Eckfenster zurück, über denselben Weg wie `data-pip-hide` (die Kachel
  // selbst erfährt nie, ob sie angedockt ist).
  const containerClass = $derived(
    [
      'bg-bg-chat flex h-full overflow-hidden',
      isFullscreen
        ? 'rounded-none border-0'
        : 'rounded-2xl border border-border handy:rounded-none handy:border-0',
      eigenesVollbild ? 'fixed inset-0 z-40' : ''
    ].join(' ')
  );

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
    reaktionenAn,
    onToggleReaktionen,
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
      docVollbild = !!document.fullscreenElement;
      if (isFullscreen) {
        vollbildBetreten();
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
  class={containerClass}
  data-testid={containerTestid}
  data-identity={identity}
  data-eigenes-vollbild={eigenesVollbild ? '' : undefined}
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

      <!-- Mobil: die schwebenden Knöpfe AUF dem Video ersetzen die Leiste
           darunter — in der Kachel wie im Vollbild dieselbe Komponente, im
           Vollbild nur fadend. Der Pfeil „Vollbild verlassen" steht NUR im
           Hochformat: quer ist das Vollbild automatisch (Kippen) und wird
           genauso automatisch verlassen, ein Pfeil wäre redundant
           (Nutzerwunsch 2026-08-26). Am Rechner bleiben Dock-Leiste und
           Doppelklick wie bisher. -->
      {#if handy}
        <TileMobilSteuerung
          {testidPrefix}
          {isFullscreen}
          fadeClass={isFullscreen ? fadeClass : ''}
          zeigeVollbildAus={handy}
          {volume}
          {volumeMax}
          {onVolumeChange}
          {onToggleMute}
          {audioBlocked}
          {onEnableAudio}
          {chatOpen}
          {onToggleChat}
          {queueOpen}
          {onToggleQueue}
          {onHide}
          onToggleFullscreen={toggleFs}
        />
      {/if}

      <!-- Diagnose-Stats oben links — nur wenn global eingeschaltet -->
      {#if showStats}
        <div class="absolute left-2 top-2 {isFullscreen ? fadeClass : ''}">
          {@render stats?.()}
        </div>
      {/if}

      <!-- Vollbild am RECHNER: Leiste als fadendes Overlay über dem unteren
           Bildrand, das nach Inaktivität (HUD_HIDE_AFTER_MS) ausgeblendet
           wird. Am Handy greift stattdessen die neue schwebende Steuerung. -->
      {#if isFullscreen && !hideDock && !handy}
        <div
          class="absolute inset-x-0 bottom-0 z-10 bg-gradient-to-t from-black/85 via-black/45 to-transparent pt-10 {fadeClass}"
        >
          <TileDock {...dockProps} overlay wide={dockWide} />
        </div>
      {/if}

      {#if isFullscreen && chatOpen}
        {@render chatOverlay?.()}
      {/if}
      {#if chatOpen && !isFullscreen && handy}
        <!-- Mobile: Chat als Vollflächen-Overlay statt Seitenpanel. -->
        <div class="absolute inset-0 z-20">
          {@render chatPanel?.()}
        </div>
      {/if}
      {#if queueOpen && !isFullscreen && handy}
        <div class="absolute inset-0 z-20">
          {@render queuePanel?.()}
        </div>
      {/if}
    </div>

    <!-- Solide Steuerleiste UNTER dem Video, nur außerhalb des Vollbilds —
         und am Handy gar nicht: dort steuern die schwebenden Knöpfe (Schließen,
         Vollbild, Lautstärke) das Bild direkt, eine Leiste darunter kostet
         nur Höhe vom Stream. Im Vollbild übernimmt das fadende Overlay. -->
    {#if !isFullscreen && !hideDock && !handy}
      <div class="bg-bg-panel border-t border-border">
        <TileDock {...dockProps} overlay={false} wide={dockWide} />
      </div>
    {/if}
  </div>

  {#if chatOpen && !isFullscreen && !handy}
    {@render chatPanel?.()}
  {/if}
  {#if queueOpen && !isFullscreen && !handy}
    {@render queuePanel?.()}
  {/if}
</div>
