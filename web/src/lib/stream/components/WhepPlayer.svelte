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
  import RemoteRequestButton from '$lib/remote/components/RemoteRequestButton.svelte';
  import { isElectron } from '$lib/platform/runtime';
  import { remoteSession } from '$lib/remote/session.svelte';
  import { darfFernsteuern } from '$lib/remote/darfSteuern';
  import { detachedStreams } from '../detach.svelte';
  import { openedTiles } from '../openedTiles.svelte';
  import { hqTileId } from '../hqTile';
  import { toast } from 'svelte-sonner';
  import LoaderIcon from '@lucide/svelte/icons/loader-circle';
  import AlertTriangleIcon from '@lucide/svelte/icons/triangle-alert';
  import ClipboardIcon from '@lucide/svelte/icons/clipboard';
  import CheckIcon from '@lucide/svelte/icons/check';
  import NativeWindowPanel from '$lib/player/components/NativeWindowPanel.svelte';
  import { useNativePlayback } from '$lib/player/useNativePlayback.svelte';
  import { nativePlayerSessions } from '$lib/player/store.svelte';
  import { nativeChatRequests, nativeWindowRequests } from '$lib/player/wuensche.svelte';

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
  // Dasselbe Spiel fuer die Fernsteuerbarkeit, und aus demselben Grund: sobald
  // das eigene Fenster spielt, wird `mgr` hier abgeklemmt (s. unten) — genau
  // dann zeigt die Kachel aber das `NativeWindowPanel` mit dem Anfrage-Knopf.
  // Direkt gelesen waere der Wert also immer `false`, und der Knopf erschiene
  // nie. Aendern kann er sich waehrend eines Streams ohnehin nicht.
  const desktop = isElectron();
  let fernsteuerbarGesehen = $state(false);
  $effect(() => {
    if (mgr?.fernsteuerbar) fernsteuerbarGesehen = true;
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

  // Dem Player-Fenster sagen, ob sein Anfrage-Knopf erscheinen soll.
  //
  // **Von hier und nicht aus dem Fenster-Store**: die Antwort braucht drei
  // Dinge, die genau hier zusammenkommen — ob der Streamer überhaupt
  // fernsteuerbar ist (aus der WHEP-Antwort), ob dieser Zuschauer darf
  // (Rechte im Kanal), und ob gerade schon eine Sitzung läuft. Das Fenster
  // rechnet daraus NICHTS: es zeigt den Knopf oder nicht.
  $effect(() => {
    const fenster = native.session?.fensterSitzung;
    if (typeof fenster !== 'number') return;
    const moeglich =
      fernsteuerbarGesehen &&
      remoteSession.phase === 'idle' &&
      darfFernsteuern(channelId, userId);
    void window.pulse?.player?.anfragbar?.(fenster, moeglich);
  });

  // Steht der native Player zur Verfuegung? Ohne Electron, ohne das Binary
  // ODER nach einer gescheiterten Sitzung (`nativeFailed`) fuehrt der
  // Abkoppel-Knopf in das zweite Browser-Fenster wie eh und je — sonst taete
  // er sichtbar nichts, weil `useNativePlayback` nach einem Fehler dauerhaft
  // beim `<video>`-Weg bleibt.
  const nativMoeglich = $derived(native.verfuegbar && !native.nativeFailed);

  // Beschriftung des EINEN Knopfes. Sie muss die jeweilige Bedeutung tragen —
  // derselbe Knopf oeffnet, holt zurueck oder holt nach vorne.
  function fensterTitelFuer(): string {
    if (!nativMoeglich) return m.tile_shell_detach();
    if (native.erzwungen) return m.whep_player_native_toggle_forced();
    if (useNative) return m.whep_player_native_toggle_off();
    return m.tile_shell_detach();
  }
  const fensterTitel = $derived(fensterTitelFuer());

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

  // Der Schliessen-Knopf IM Fenster soll die Kachel zumachen — dieselbe Wirkung
  // wie das X hier. Die Sitzung kennt die Kachel-Registry nicht, deshalb haengt
  // sie den Weg dorthin als Rueckruf ein.
  $effect(() => {
    const s = native.session;
    if (!s) return;
    s.onCloseTile = (cid, uid, slot) =>
      openedTiles.close('hq', cid, hqTileId(uid, slot));
    return () => {
      s.onCloseTile = null;
    };
  });

  // Chat-Knopf im Fenster: der Hauptprozess holt die App nach vorne, hier geht
  // der Chat auf. Ueber einen Zaehler, damit auch das zweite Druecken wirkt.
  let chatWunschGesehen = $state(0);
  $effect(() => {
    const n = nativeChatRequests.count(channelId, userId, streamSlot);
    if (n > chatWunschGesehen) {
      chatWunschGesehen = n;
      chatOpen = true;
    }
  });

  // Anzeige-Zustand: im nativen Modus spiegelt der Overlay den Sitzungsstatus
  // des Players statt des Browser-Managers (dessen `mgr.phase` weiterläuft,
  // ist hier aber nicht das, was der Viewer gerade sieht).
  // Wer den Ton ausgibt, setzt die Sitzung selbst (sie ueberlebt den Unmount
  // dieser Kachel). Hier NOCHMAL, weil `ensure()` eine BESTEHENDE Sitzung
  // zurueckgeben kann, waehrend der Manager frisch ist — dann hat die Sitzung
  // ihr `open()` schon hinter sich und wuerde nie mehr stummschalten.
  $effect(() => {
    // **Diese Zeile ist seit dem 2026-08-03 wirkungslos, und das ist belegt.**
    // `useNative && native.phase === 'playing'` ist genau die Bedingung, unter
    // der der Effect weiter oben `mgr = null` setzt — hier steht dann nie ein
    // Manager zur Verfuegung. Sie bleibt trotzdem stehen: sie schadet nicht,
    // und wer die Abklemmung im Keep-Alive einmal zurueckbaut, braucht sie
    // wieder. Wer sie anfasst, lese `HqStreamKeepAlive.svelte` mit.
    //
    // Das Ruhen der Verbindung setzt die `NativePlayerSession` selbst
    // (`store.svelte.ts::#setRuhend`) — die ueberlebt den Unmount dieser Kachel
    // und ist damit die einzige Stelle, die es zuverlaessig kann.
    mgr?.setNativeAudio(useNative && native.phase === 'playing');
  });

  // Zwei Bedienleisten fuer denselben Stream sind Murks: sobald das Bild im
  // eigenen Fenster laeuft, ist DESSEN Leiste die einzige. Erst ab `playing` —
  // waehrend des Verbindens (und wenn es scheitert) muss die Kachel bedienbar
  // bleiben, sonst haette man gar nichts.
  const hideDock = $derived(useNative && native.phase === 'playing');

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

  /**
   * „In eigenem Fenster öffnen" — EIN Knopf, zwei Wege.
   *
   * Aus Sicht des Zuschauers ist es dieselbe Sache: der Stream soll raus aus
   * der Kachel. Womit das Fenster gebaut ist, ist eine technische Frage und
   * gehoert nicht auf die Oberflaeche. Deshalb entscheidet die Umgebung:
   * steht der native Player zur Verfuegung (Electron + Binary), nimmt er den
   * Stream; sonst bleibt es beim zweiten Browser-Fenster.
   *
   * Der native Weg ist dabei der bessere — eigenes Fenster heisst dort auch
   * NVDEC statt Software-Decode und spuerbar weniger Verzoegerung (gemessen,
   * s. `playerSettings.onlyTenBit`). Im Browser gibt es ihn nicht, dort traegt
   * der Popup-Weg alles ausser AV1 10 bit.
   */
  function handleDetach(): void {
    if (nativMoeglich) {
      // 10 bit laesst keine Wahl (das `<video>` kann es nicht darstellen), der
      // Knopf kann dort also nicht zurueckholen. Statt ins Leere zu greifen
      // holt er das Fenster nach vorne — es oeffnet ohne Aktivierung und liegt
      // gern hinter der App.
      if (native.erzwungen) {
        native.session?.focus();
        return;
      }
      if (useNative) {
        // Zurueck in die Kachel: erst die Anforderung zuruecknehmen, dann das
        // Fenster wirklich schliessen — sonst bliebe es offen stehen, waehrend
        // die Kachel schon wieder zeigt.
        //
        // `zugemacht` statt `release`: mit gesetzter Vorgabe-fuer-alles
        // (`playerSettings.useNativePlayer`) reicht die Ruecknahme der
        // Anforderung nicht — die Vorgabe schickte die Kachel sofort wieder ins
        // Fenster, und dieser Knopf haette sichtbar nichts getan.
        nativeWindowRequests.zugemacht(channelId, userId, streamSlot);
        nativePlayerSessions.close(channelId, userId, streamSlot);
      } else {
        nativeWindowRequests.request(channelId, userId, streamSlot);
      }
      return;
    }
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
  detachLabel={fensterTitel}
  {hideDock}
  onHide={canHide ? () => openedTiles.close('hq', channelId, hqTileId(userId, streamSlot)) : undefined}
  stats={useNative ? undefined : statsPill}
>
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
  {#snippet controlsExtra()}
    <!--
      „Fernsteuerung anfragen" — in der BEDIENLEISTE der Kachel, nicht in der
      Platzhalter-Flaeche des Player-Fensters.

      **Hier stand bis 2026-08-16 nichts**, und der Knopf sass im
      `NativeWindowPanel` — also nur dort, wo das Player-Fenster bereits lief.
      Der Weg zum Steuern war damit: Fenster oeffnen, zurueck ins Pulse-Fenster
      wechseln, in der Kachel klicken. Drei Schritte, von denen der erste nichts
      mit der Absicht zu tun hat: wer steuern will, will nicht erst ein Fenster.

      Jetzt reicht der Klick beim Zusehen; das Fenster geht auf, sobald der Host
      zusagt (`$lib/remote/fenster.ts`). Nur unter Electron: erfasst wird IM
      Player-Fenster (Zeigerfang, rohe Scancodes), im Browser gaebe der Knopf
      eine Zusage, die niemand einloest.
    -->
    {#if desktop && fernsteuerbarGesehen}
      <RemoteRequestButton channelId={channelId} hostUserId={userId} slot={streamSlot} />
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
