<!--
  WhepPlayer — plays back a channel's HQ stream (GSR → MediaMTX) over WHEP (T4).

  Props: `{ channelId, userId }` — the component fetches the WHEP URL itself via
  `chatApi.getWhepUrl(channelId)` (membership-gated chat-gateway proxy) and
  then runs the WHEP handshake (`$lib/stream/whep.ts`).

  Resilience:
  - If the WHEP POST 404s (publisher not online yet) or the network is down, we
    retry with backoff. Same when `pc.connectionState` goes `failed`.
  - On unmount / channel change we close the peer connection and best-effort
    DELETE the WHEP resource.

  Audio: a stream viewer wants to *hear* the stream, so the `<video>` is not
  muted. Browsers may still block autoplay-with-sound → `audioBlocked`.

  Die gesamte Chrome (HUD, Buttons, Fullscreen, Stats-Pille, Chat-Slots) liegt
  in `TileShell` — diese Component hält nur noch WHEP-Verbindung + Audio-Graph.
-->
<script lang="ts">
  import { m } from '$lib/paraglide/messages.js';
  import { formatDiagnostic } from '../whep-stats';
  import { hqStreams, type ManagedHqStream } from '../hqStreamManager.svelte';
  import { acquireWakeLock } from '$lib/platform/wakeLock';
  import StreamChatOverlay from './StreamChatOverlay.svelte';
  import StreamChatInlineInput from './StreamChatInlineInput.svelte';
  import StreamChatPanel from './StreamChatPanel.svelte';
  import TileShell from './TileShell.svelte';
  import { detachedStreams } from '../detach.svelte';
  import { openedTiles } from '../openedTiles.svelte';
  import { hqTileId } from '../hqTile';
  import { toast } from 'svelte-sonner';
  import LoaderIcon from '@lucide/svelte/icons/loader-circle';
  import AlertTriangleIcon from '@lucide/svelte/icons/triangle-alert';
  import ClipboardIcon from '@lucide/svelte/icons/clipboard';
  import CheckIcon from '@lucide/svelte/icons/check';
  import AppWindowIcon from '@lucide/svelte/icons/app-window';
  import NativeWindowPanel from '$lib/player/components/NativeWindowPanel.svelte';
  import { useNativePlayback } from '$lib/player/useNativePlayback.svelte';
  import { playerSettings, setUseNativePlayer } from '$lib/player/store.svelte';
  import { isElectron } from '$lib/platform/runtime';
  import { isPlayerAvailable } from '$lib/player/client';

  let {
    channelId,
    userId,
    streamSlot = 0,
    name,
    canDetach = true,
    canHide = true
  }: {
    channelId: string;
    userId: string;
    /** Which of the user's streams this tile plays (0 = primary, 1 = second). */
    streamSlot?: number;
    name?: string;
    /** Wenn false, kein Detach-Button — z.B. im bereits entkoppelten Popup. */
    canDetach?: boolean;
    /** Wenn false, kein Hide-Button — im Popup-Fenster sinnlos. */
    canHide?: boolean;
  } = $props();

  let videoEl = $state<HTMLVideoElement | null>(null);
  let chatOpen = $state(false);

  // Die WHEP-Verbindung + der Ton gehören dem dauerhaften Manager (überlebt die
  // Navigation, siehe hqStreamManager). ensure() ist idempotent — der Keep-
  // Alive-Abgleicher im Layout besitzt die Lebensdauer + den Abbau. Diese
  // Komponente hängt nur ihr Video-Bild an den (evtl. schon laufenden) Stream.
  let mgr = $state<ManagedHqStream | null>(null);
  // Einmal gesehen, bleibt gemerkt — und genau deshalb ein eigener Wert statt
  // eines Blicks auf `mgr`: die Bittiefe entscheidet ueber das Fenster, das
  // Fenster klemmt `mgr` ab, und `mgr` traegt die Bittiefe. Direkt gelesen
  // waere das ein Kreis, der sich endlos selbst umschaltet. Die Bittiefe eines
  // laufenden Streams aendert sich ohnehin nicht.
  let tenBitGesehen = $state(false);
  $effect(() => {
    if (mgr?.tenBit) tenBitGesehen = true;
  });
  $effect(() => {
    // Solange das Bild NICHT im eigenen Fenster laeuft, haelt der Browser die
    // Verbindung — auch waehrend das Fenster erst hochkommt, damit ein
    // gescheiterter Start nahtlos auf `<video>` zurueckfaellt.
    //
    // Sobald es laeuft, wird sie abgeklemmt (Gegenstueck in
    // `HqStreamKeepAlive`, Begruendung dort): das Fenster gibt Bild und Ton
    // aus, eine zweite Kopie desselben Streams zu dekodieren bringt nichts —
    // und ein Decoder, der daran scheitert, fordert Vollbilder an und
    // beschaedigt den Strom fuer alle.
    //
    // Die Bittiefe, an der die Fenster-Pflicht haengt, ist zu diesem Zeitpunkt
    // laengst bekannt: sie kommt aus der WHEP-Antwort dieser Verbindung, die
    // vor dem Fenster steht.
    mgr = native.session?.phase === 'playing'
      ? null
      : hqStreams.ensure(channelId, userId, streamSlot);
  });

  // Nativer HQ-Player (Electron, experimentell — `streaming/pulse-player/`):
  // ersetzt nur das BILD. Der Ton kommt unveraendert aus `mgr` weiter (dessen
  // Video-Element ist immer stumm, siehe hqStreamManager.svelte.ts) — die
  // Browser-WHEP-Verbindung laeuft also so oder so, unabhaengig davon, ob wir
  // ihr Video anzeigen. Logik ausgelagert (Groessen-Policy): siehe
  // `useNativePlayback.svelte.ts`.
  const native = useNativePlayback(() => ({
    channelId,
    userId,
    slot: streamSlot,
    title: name,
    // Aus der WHEP-Antwort, die der Manager ohnehin holt — bekannt, bevor
    // irgendetwas dekodiert ist. Steht sie noch aus, ist der Wert `false`,
    // und die Kachel startet im `<video>`-Weg; kommt danach `true`, schaltet
    // dieser abgeleitete Wert die Kachel um.
    tenBit: tenBitGesehen
  }));
  const useNative = $derived(native.active);

  // Ob der Knopf ueberhaupt erscheint: ohne Electron oder ohne das Binary gibt
  // es kein Fenster, in das man umschalten koennte.
  let playerVerfuegbar = $state(false);
  $effect(() => {
    if (isElectron()) void isPlayerAvailable().then((v) => (playerVerfuegbar = v));
  });

  const fensterTitel = $derived(
    native.erzwungen
      ? m.whep_player_native_toggle_forced()
      : useNative
        ? m.whep_player_native_toggle_off()
        : m.whep_player_native_toggle_on()
  );

  // Video an den Manager-Stream binden — re-läuft, sobald der Stream (neu)
  // verbindet. Beim Unmount NUR das Video lösen; die Verbindung läuft weiter.
  // Kein Attach, solange der native Player das Bild zeigt.
  $effect(() => {
    const m = mgr;
    const el = videoEl;
    if (!m || !el || useNative) return;
    void m.stream; // tracken → Re-Attach bei (Wieder-)Verbindung
    m.attachVideo(el);
    return () => m.detachVideo(el);
  });

  // Anzeige-Zustand: im nativen Modus spiegelt der Overlay den Sitzungsstatus
  // des Players statt des Browser-Managers (dessen `mgr.phase` weiterläuft,
  // ist hier aber nicht das, was der Viewer gerade sieht).
  // Wer den Ton ausgibt, setzt die Sitzung selbst (sie ueberlebt den Unmount
  // dieser Kachel). Hier NOCHMAL, weil `ensure()` eine BESTEHENDE Sitzung
  // zurueckgeben kann, waehrend der Manager frisch ist — dann hat die Sitzung
  // ihr `open()` schon hinter sich und wuerde nie mehr stummschalten.
  $effect(() => {
    mgr?.setNativeAudio(useNative && native.phase === 'playing');
  });

  const phase = $derived(useNative ? native.phase : (mgr?.phase ?? 'connecting'));
  const detail = $derived(useNative ? native.detail : (mgr?.detail ?? ''));
  const stats = $derived(mgr?.stats ?? null);
  const audioBlocked = $derived(mgr?.audioBlocked ?? false);
  const volume = $derived(mgr?.volume ?? 100);

  // Der Schieber schreibt weiter auf `mgr` — dort haengt die Persistenz je
  // Streamer und der angezeigte Wert. Gibt das Fenster den Ton aus, ist `mgr`
  // stummgeschaltet (`nativeAudio`), also muss der Wert zusaetzlich dorthin.
  function handleVolume(e: Event) {
    const v = Number((e.currentTarget as HTMLInputElement).value);
    mgr?.setVolume(v);
    native.session?.setVolume(v);
  }
  function toggleMute() {
    mgr?.toggleMute();
    if (mgr) native.session?.setVolume(mgr.volume);
  }
  function enableAudio() {
    void mgr?.enableAudio();
  }

  function handleDetach(): void {
    const opened = detachedStreams.open(channelId, userId, streamSlot);
    if (!opened) {
      toast.error(m.whep_player_popup_blocked(), {
        description: m.whep_player_popup_blocked_description()
      });
    }
  }

  // Monitor wach halten, solange das Bild hier wirklich läuft — an die
  // SICHTBARE Kachel gebunden (nicht an den Manager): nur wer zuschaut, braucht
  // den Bildschirm wach; im Hintergrund (nur Ton) darf er schlafen.
  $effect(() => {
    if (phase !== 'playing') return;
    const release = acquireWakeLock();
    return release;
  });

  // Stats-Diagnose in die Zwischenablage (Button in der Stats-Pille).
  let copied = $state(false);
  let copyResetTimer: ReturnType<typeof setTimeout> | undefined;
  async function copyDiagnostic() {
    if (!stats) return;
    try {
      await navigator.clipboard.writeText(formatDiagnostic(stats.diagnostic, { name }));
      copied = true;
      clearTimeout(copyResetTimer);
      copyResetTimer = setTimeout(() => {
        copied = false;
        copyResetTimer = undefined;
      }, 1500);
    } catch {
      /* clipboard API kann in non-secure-Contexts failen — silent */
    }
  }

  $effect(() => () => clearTimeout(copyResetTimer));
</script>

<!-- Stats-Pille: Codec/FPS/Bitrate + Freeze/Stutter-Warnung. Positionierung
     übernimmt TileShell, hier nur der Pillen-Inhalt. -->
{#snippet statsPill()}
  {#if phase === 'playing' && stats}
    <div
      class="flex items-center gap-1.5 rounded-full px-2.5 py-1 font-mono text-2xs text-white backdrop-blur-sm {stats.frozen
        ? 'animate-pulse bg-destructive/80'
        : 'bg-black/55'}"
      data-testid="hq-stream-stats"
      data-frozen={stats.frozen}
    >
      <span>{stats.res}</span><span>·</span><span>{stats.fps}</span><span>·</span><span
        >{stats.bitrate}</span
      ><span>·</span><span>{stats.codec}</span>
      {#if stats.frozen}
        <span class="ml-1 font-sans font-semibold uppercase tracking-wide"
          >freeze {stats.freezeSeconds.toFixed(0)}s</span
        >
      {:else if stats.microStutters > 0}
        <span
          class="ml-1 font-sans text-warning"
          title={m.whep_player_microstutter_title()}
        >⚠ {stats.microStutters}</span>
      {/if}
      <button
        type="button"
        onclick={copyDiagnostic}
        class="ml-1 -mr-0.5 flex size-4 items-center justify-center rounded-full text-white/80 hover:bg-white/10 hover:text-white"
        aria-label={m.whep_player_copy_diagnostic_aria()}
        title={copied ? m.whep_player_diagnostic_copied() : m.whep_player_copy_diagnostic()}
        data-testid="hq-stream-stats-copy"
      >
        {#if copied}<CheckIcon class="size-3" />{:else}<ClipboardIcon class="size-3" />{/if}
      </button>
    </div>
  {/if}
{/snippet}

<TileShell
  kind="hq"
  containerTestid="hq-stream-player"
  testidPrefix="hq-stream"
  name={name ?? 'Stream'}
  nameTestid="hq-stream-streamer-name"
  video={videoEl}
  forceHud={audioBlocked}
  {volume}
  onVolumeChange={handleVolume}
  onToggleMute={toggleMute}
  {audioBlocked}
  onEnableAudio={enableAudio}
  {chatOpen}
  onToggleChat={() => (chatOpen = !chatOpen)}
  onDetach={canDetach ? handleDetach : undefined}
  onHide={canHide ? () => openedTiles.close('hq', channelId, hqTileId(userId, streamSlot)) : undefined}
  stats={useNative ? undefined : statsPill}
>
  {#snippet controlsExtra()}
    <!-- Wiedergabe im eigenen Fenster. Bei 10 bit gesperrt und AN: das
         `<video>` daneben kann mehr als 8 bit nicht darstellen, die Wahl
         existiert dort also nicht. Sichtbar bleibt der Knopf trotzdem — ein
         verschwundenes Bedienelement erklaert nichts, ein gesperrtes mit
         Begruendung schon. Nur unter Electron und nur, wenn das Binary da ist
         (sonst gibt es nichts umzuschalten). -->
    {#if playerVerfuegbar}
      <button
        type="button"
        onclick={() => setUseNativePlayer(!playerSettings.useNativePlayer)}
        disabled={native.erzwungen}
        class="flex items-center justify-center rounded-full bg-black/55 p-3 text-white backdrop-blur-sm hover:bg-white/20 disabled:cursor-not-allowed disabled:opacity-60 md:p-1.5"
        class:text-primary={useNative}
        aria-pressed={useNative}
        aria-label={fensterTitel}
        title={fensterTitel}
        data-testid="hq-stream-native-toggle"
      >
        <AppWindowIcon class="size-5 md:size-3.5" />
      </button>
    {/if}
  {/snippet}
  {#snippet media()}
    {#if useNative}
      <!-- Bild UND Ton laufen im eigenen Fenster (pulse-player). Die Kachel ist
           dann das Cockpit: Lautstaerke/Chat liefert die TileShell, die
           Messwerte und der Weg zurueck zum Fenster stehen im Panel. -->
      <NativeWindowPanel session={native.session} />
    {:else}
      <!-- svelte-ignore a11y_media_has_caption -->
      <video
        bind:this={videoEl}
        autoplay
        playsinline
        class="h-full w-full bg-black object-contain"
      ></video>
    {/if}
  {/snippet}
  {#snippet overlay()}
    {#if phase === 'connecting' || phase === 'retrying'}
      <div
        class="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/55 text-white"
      >
        <LoaderIcon class="size-7 animate-spin" />
        <p class="text-sm">
          {phase === 'retrying' ? m.whep_player_waiting_for_stream() : m.whep_player_connecting_to_stream()}
        </p>
        {#if detail && phase === 'retrying'}
          <p class="max-w-sm text-center text-2xs text-white/60">{detail}</p>
        {/if}
      </div>
    {:else if phase === 'error'}
      <div
        class="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/65 text-destructive"
      >
        <AlertTriangleIcon class="size-7" />
        <p class="text-sm">{m.whep_player_stream_load_failed()}</p>
        {#if detail}<p class="max-w-sm text-center text-2xs text-destructive/70">{detail}</p>{/if}
      </div>
    {/if}
  {/snippet}
  {#snippet chatPanel()}
    <StreamChatPanel {channelId} streamerId={userId} onClose={() => (chatOpen = false)} />
  {/snippet}
  {#snippet chatOverlay()}
    <StreamChatOverlay {channelId} streamerId={userId} />
    <StreamChatInlineInput {channelId} streamerId={userId} />
  {/snippet}
</TileShell>
