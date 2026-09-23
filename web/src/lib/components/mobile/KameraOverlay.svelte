<!--
  Kamera-Overlay (Testrunde 2026-09-23): Vollbild in der App, Pulse-Design.
  Foto UND Video aus demselben Live-Stream — der Modus-Wechsel ist instant,
  weil beide denselben Stream nutzen (nur der Auslöser verhält sich anders).

  Video über die Canvas-Zwischenstufe: MediaRecorder nimmt den Canvas-Stream
  auf, in den laufend das Kamerabild gezeichnet wird — ein Kamera-Wechsel
  MITTEN in der Aufnahme tauscht nur die Quelle (Grenze bewusst: 2D-Neu-
  kodierung, kein Hardware-Encoder).

  Nach dem Stopp: Vorschau mit eigener Steuerung (Play/Pause, Spulen, Ton)
  → Senden geht DIREKT raus (Parent lädt hoch und schickt die Nachricht,
  kein Entwurf in der Anhang-Leiste).

  Lade-Verhalten: das graue WebView-Kästchen für noch nicht startende
  <video>-Elemente wird durch schwarze Lade-Flächen verdeckt; die Freigabe
  erfolgt über den ersten GEZEICHNETEN Frame (requestVideoFrameCallback),
  nicht über das zu frühe „playing"-Ereignis.

  Kamera-Wechsel (Testrunde 2026-09-23): kein Lade-Loch — das letzte Bild
  der alten Kamera steht als Canvas-Standbild über dem Video, bis der
  erste gezeichnete Frame der neuen Kamera dahinter steht; erst dann
  verschwindet das Standbild (harter Schnitt).
-->
<script lang="ts">
  import CameraIcon from '@lucide/svelte/icons/camera';
  import CheckIcon from '@lucide/svelte/icons/check';
  import LoaderCircleIcon from '@lucide/svelte/icons/loader-circle';
  import PauseIcon from '@lucide/svelte/icons/pause';
  import PlayIcon from '@lucide/svelte/icons/play';
  import SendHorizontalIcon from '@lucide/svelte/icons/send-horizontal';
  import SquareIcon from '@lucide/svelte/icons/square';
  import SwitchCameraIcon from '@lucide/svelte/icons/switch-camera';
  import VideoIcon from '@lucide/svelte/icons/video';
  import XIcon from '@lucide/svelte/icons/x';
  import Volume2Icon from '@lucide/svelte/icons/volume-2';
  import VolumeXIcon from '@lucide/svelte/icons/volume-x';
  import { aufnahmeDauerRegister, formatiereDauer } from '$lib/attachments/aufnahmeKern';
  import { m } from '$lib/paraglide/messages.js';
  import { Portal } from 'bits-ui';
  import { untrack } from 'svelte';

  let {
    open,
    sendeLaeuft = false,
    onClose,
    onSend
  }: {
    open: boolean;
    /** Wahr, während der Parent das Medium hochlädt und sendet. */
    sendeLaeuft?: boolean;
    onClose: () => void;
    onSend: (file: File) => void;
  } = $props();

  type Modus = 'foto' | 'video';
  let modus = $state<Modus>('foto');
  let video: HTMLVideoElement | undefined = $state();
  let fehler = $state(false);
  let nutzeFront = $state(false);
  let liveLaeuft = $state(false);
  let ladeMindestens = $state(false);
  let ladeTimer: ReturnType<typeof setTimeout> | undefined;
  /** Erster GEZEICHNETER Frame — `playing` allein feuert früher und lässt
   *  das Grau durchblitzen (Testrunde 2026-09-11/23). */
  let ersteFrameDa = $state(false);
  /** Genau zwei Kamera-Geräte (Haupt + Front), beim ersten Wechsel per
   *  facingMode-Probe ermittelt — Kreisen über alle Geräte lief auf dem
   *  Samsung „Front 1, Front 2" durch. */
  let hauptKameraId: string | undefined;
  let frontKameraId: string | undefined;
  let stream: MediaStream | undefined;
  let videoTrack: MediaStreamTrack | undefined;

  // Kamera-Wechsel ohne Lade-Loch: das letzte Bild der laufenden Kamera
  // wird eingefroren (Canvas-Schnappschuss) und ÜBER dem Video gezeigt, bis
  // der erste GEZEICHNETE Frame der anderen Kamera da ist — dann harter
  // Schnitt. Die alte Kamera muss trotzdem ZUERST freigegeben werden
  // (Android öffnet keine zweite gleichzeitig), aber das passiert jetzt
  // HINTER dem Standbild.
  let wechselLaeuft = $state(false);
  let wechselLeinwand = document.createElement('canvas');
  let wechselAnzeige: HTMLCanvasElement | undefined = $state();
  let wechselWache: ReturnType<typeof setTimeout> | undefined;

  function bildEinfrieren(): void {
    if (!video?.videoWidth) return; // noch kein Bild → alter Lade-Weg greift
    wechselLeinwand.width = video.videoWidth;
    wechselLeinwand.height = video.videoHeight;
    wechselLeinwand.getContext('2d')?.drawImage(video, 0, 0);
    wechselLaeuft = true;
    // Notfall-Aus: hängt der Wechsel, friert das Standbild nicht für immer.
    clearTimeout(wechselWache);
    wechselWache = setTimeout(() => (wechselLaeuft = false), 4000);
  }

  // Aufnahme (Canvas-Zwischenstufe)
  let zeichenLeinwand = document.createElement('canvas');
  let zeichenRahmen = 0;
  let rekorder: MediaRecorder | undefined;
  let rekordTeile: Blob[] = [];
  let nimmtAuf = $state(false);

  // Wisch-Geste (WhatsApp-Prinzip): links/rechts wischen wechselt zwischen
  // Foto und Video. `touch-action: none` am Container sorgt dafür, dass der
  // WebView die Geste nicht als Scrollen schluckt.
  let wischStartX: number | null = null;

  function wischStart(e: TouchEvent): void {
    if (nimmtAuf || entwurfDatei) return;
    wischStartX = e.touches[0]?.clientX ?? null;
  }

  function wischEnde(e: TouchEvent): void {
    const start = wischStartX;
    wischStartX = null;
    if (start === null || nimmtAuf || entwurfDatei) return;
    const dx = (e.changedTouches[0]?.clientX ?? start) - start;
    // Wischen = nur Modus wechseln (pure state, KEIN Stream-Restart — der
    // alte Weg rief starten() und ließ die Kamera neu anlaufen).
    if (dx < -60 && modus === 'foto') {
      modus = 'video';
    } else if (dx > 60 && modus === 'video') {
      modus = 'foto';
    }
  }
  let rekordSekunden = $state(0);
  let rekordTimer: ReturnType<typeof setInterval> | undefined;

  // Entwurf (Vorschau nach dem Stopp)
  let entwurfUrl = $state<string | undefined>();
  let vorschau: HTMLVideoElement | undefined = $state();
  let entwurfDatei: File | null = $state(null);
  let entwurfIstVideo = $state(false);
  let vorschauLaeuft = $state(false);
  let vorschauBereit = $state(false);
  let vorschauPosition = $state(0);
  let vorschauStumm = $state(false);
  let vorschauRahmen = 0;

  function besterVideoMime(): string | undefined {
    if (typeof MediaRecorder === 'undefined') return undefined;
    const kandidaten = ['video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4'];
    return kandidaten.find((moeglich) => MediaRecorder.isTypeSupported(moeglich));
  }

  function entwurfWeg(): void {
    if (entwurfUrl) URL.revokeObjectURL(entwurfUrl);
    entwurfUrl = undefined;
    entwurfDatei = null;
    vorschauLaeuft = false;
    vorschauBereit = false;
    vorschauPosition = 0;
    vorschauStumm = false;
  }

  function anzeigeBinden(): void {
    if (video && stream) {
      if (video.srcObject !== stream) {
        ersteFrameDa = false;
        liveLaeuft = false;
        video.srcObject = stream;
      }
      void video.play().catch(() => {});
      ersteFrameAbwarten(video);
    }
  }

  /** Erster GEZEICHNETER Frame: `playing` feuert manchmal vor dem ersten
   *  Bild — rVFC erst, wenn wirklich gerendert wurde (Fallback: Zeit). */
  function ersteFrameAbwarten(el: HTMLVideoElement): void {
    const mitCallback = el as HTMLVideoElement & {
      requestVideoFrameCallback?: (cb: () => void) => number;
    };
    if (mitCallback.requestVideoFrameCallback) {
      mitCallback.requestVideoFrameCallback(() => (ersteFrameDa = true));
    } else if (el.readyState >= 2) {
      ersteFrameDa = true;
    } else {
      el.onloadeddata = () => (ersteFrameDa = true);
    }
  }

  $effect(() => {
    if (open) anzeigeBinden();
  });

  $effect(() => {
    // Standbild 1:1 ins angezeigte Canvas übernehmen, sobald es im DOM ist
    // (die Quelle wurde synchron VOR dem Kamera-Stopp gezeichnet).
    if (wechselLaeuft && wechselAnzeige) {
      wechselAnzeige.width = wechselLeinwand.width;
      wechselAnzeige.height = wechselLeinwand.height;
      wechselAnzeige.getContext('2d')?.drawImage(wechselLeinwand, 0, 0);
    }
  });

  $effect(() => {
    // Der Schnitt: der erste GEZEICHNETE Frame der neuen Kamera löst das
    // Standbild ab (gleiches Signal, das auch die anfängliche Lade-Fläche
    // kennt — nicht das zu frühe „playing“).
    if (wechselLaeuft && ersteFrameDa) wechselLaeuft = false;
  });

  async function starten(): Promise<void> {
    fehler = false;
    liveLaeuft = false;
    ersteFrameDa = false;
    ladeMindestens = true;
    clearTimeout(ladeTimer);
    ladeTimer = setTimeout(() => (ladeMindestens = false), 1400);
    try {
      stream?.getTracks().forEach((t) => t.stop());
      stream = await navigator.mediaDevices.getUserMedia({
        // Ton immer mit — der Video-Modus braucht ihn, Foto ignoriert ihn.
        video: { facingMode: nutzeFront ? 'user' : 'environment' },
        audio: true
      });
      videoTrack = stream.getVideoTracks()[0];
      untrack(() => anzeigeBinden());
      // Notfall: kein Ereignis → Spinner löst sich nach 4 s von selbst.
      setTimeout(() => {
        if (stream) liveLaeuft = true;
      }, 4000);
    } catch {
      fehler = true;
    }
  }

  /** Kamera-Wechsel — MITTEN in der Aufnahme über den Track-Tausch des
   *  Canvas-Streams; außerhalb nur ein Stream-Neustart. Parallel-Start
   *  (alte Kamera läuft bis die neue liefert) mit Fallback auf
   *  Stopp-dann-Start, wenn das Gerät zwei Kameras nicht gleichzeitig
   *  öffnen mag (Testrunde 2026-09-23). Sichtbar bleibt DURCHGAENIG das
   *  alte Standbild, bis die neue Kamera ihren ersten Frame zeichnet. */
  async function kameraWechseln(): Promise<void> {
    if (wechselLaeuft) return; // kein Doppel-Tipp in einen laufenden Wechsel
    // 0. Standbild sichern, BEVOR die Kamera freigegeben wird — alles
    //    Weitere (Freigabe, Probing, Neustart) passiert dahinter.
    bildEinfrieren();
    try {
      // 1. Laufende Kamera FREIGEBEN — Android hält sie sonst belegt und die
      //    Anfrage für die andere scheitert mit NotReadableError
      //    (Testrunde 2026-09-23).
      videoTrack?.stop();
      videoTrack = undefined;
      // 2. Kandidaten ermitteln (einmalig) — facingMode-Weichanfrage je Seite.
      if (!hauptKameraId || !frontKameraId) {
        try {
          const rueck = await navigator.mediaDevices.getUserMedia({
            video: { facingMode: 'environment' }
          });
          hauptKameraId = rueck.getVideoTracks()[0].getSettings().deviceId;
          rueck.getTracks().forEach((t) => t.stop());
          const vorne = await navigator.mediaDevices.getUserMedia({
            video: { facingMode: 'user' }
          });
          frontKameraId = vorne.getVideoTracks()[0].getSettings().deviceId;
          vorne.getTracks().forEach((t) => t.stop());
        } catch {
          // Erkennung fehlgeschlagen — Fallback unten greift.
        }
      }
      nutzeFront = !nutzeFront;
      const ziel = nutzeFront ? frontKameraId : hauptKameraId;
      let neu: MediaStream | undefined;
      try {
        neu = await navigator.mediaDevices.getUserMedia({
          video: ziel ? { deviceId: { exact: ziel } } : { facingMode: nutzeFront ? 'user' : 'environment' },
          audio: true
        });
      } catch {
        // Fallback: weiche facingMode-Anfrage statt exakter Geräte-ID.
        neu = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: nutzeFront ? 'user' : 'environment' },
          audio: true
        });
      }
      videoTrack = neu.getVideoTracks()[0];
      const audio = stream?.getAudioTracks() ?? [];
      stream = new MediaStream([videoTrack, ...audio]);
      anzeigeBinden();
    } catch {
      // Beide Anfragen scheitern: nicht im Standbild erstarren, sondern den
      // bekannten Fehler zeigen (statt eines unhandled rejection).
      fehler = true;
      wechselLaeuft = false;
    }
  }

  function zeichneRahmen(): void {
    if (!nimmtAuf) return;
    if (zeichenLeinwand && video && video.videoWidth) {
      zeichenLeinwand
        .getContext('2d')
        ?.drawImage(video, 0, 0, zeichenLeinwand.width, zeichenLeinwand.height);
    }
    zeichenRahmen = requestAnimationFrame(zeichneRahmen);
  }

  async function videoStarten(): Promise<void> {
    const mime = besterVideoMime();
    if (!mime || !stream || !video) {
      fehler = true;
      return;
    }
    zeichenLeinwand.width = video.videoWidth || 720;
    zeichenLeinwand.height = video.videoHeight || 1280;
    zeichenLeinwand
      .getContext('2d')
      ?.drawImage(video, 0, 0, zeichenLeinwand.width, zeichenLeinwand.height);
    const kombinat = new MediaStream([
      zeichenLeinwand.captureStream(30).getVideoTracks()[0],
      ...stream.getAudioTracks()
    ]);
    rekordTeile = [];
    rekorder = new MediaRecorder(kombinat, { mimeType: mime });
    rekorder.ondataavailable = (e) => {
      if (e.data.size > 0) rekordTeile.push(e.data);
    };
    rekorder.onstop = () => {
      nimmtAuf = false;
      cancelAnimationFrame(zeichenRahmen);
      clearInterval(rekordTimer);
      const typ = mime.split(';')[0];
      const blob = new Blob(rekordTeile, { type: typ });
      if (blob.size === 0) {
        fehler = true;
        return;
      }
      vorschauBereit = false; // Lade-Fläche bis der erste Frame steht
      entwurfUrl = URL.createObjectURL(blob);
      entwurfDatei = new File([blob], `kamera-video-${Date.now()}.webm`, { type: typ });
      entwurfIstVideo = true;
      aufnahmeDauerRegister.set(entwurfDatei, rekordSekunden);
    };
    rekorder.start();
    nimmtAuf = true;
    rekordSekunden = 0;
    rekordTimer = setInterval(() => (rekordSekunden += 1), 1000);
    zeichenRahmen = requestAnimationFrame(zeichneRahmen);
  }

  function videoUmschalten(): void {
    if (nimmtAuf) {
      rekorder?.stop();
      return; // fertig läuft über rekorder.onstop → Vorschau
    }
    void videoStarten();
  }

  function schiessen(): void {
    if (!video || !video.videoWidth) return;
    const leinwand = document.createElement('canvas');
    leinwand.width = video.videoWidth;
    leinwand.height = video.videoHeight;
    leinwand.getContext('2d')?.drawImage(video, 0, 0);
    leinwand.toBlob(
      (blob) => {
        if (!blob) return;
        entwurfWeg();
        entwurfUrl = URL.createObjectURL(blob);
        entwurfDatei = new File([blob], `kamera-${Date.now()}.jpg`, { type: 'image/jpeg' });
        entwurfIstVideo = false;
      },
      'image/jpeg',
      0.9
    );
  }

  function entwurfVerwerfen(): void {
    entwurfWeg();
  }

  function entwurfSenden(): void {
    if (!entwurfDatei) return;
    const datei = entwurfDatei;
    entwurfWeg();
    onSend(datei); // Parent lädt hoch, sendet und schließt das Overlay.
  }

  function schliessen(): void {
    if (nimmtAuf) rekorder?.stop();
    cancelAnimationFrame(zeichenRahmen);
    clearInterval(rekordTimer);
    clearTimeout(wechselWache);
    wechselLaeuft = false;
    entwurfWeg();
    stream?.getTracks().forEach((t) => t.stop());
    stream = undefined;
    onClose();
  }

  $effect(() => {
    // NUR `open` verfolgen — Modus-/Front-Wechsel dürfen den Effekt nicht
    // neu zünden (Cleanup stoppte sonst den frischen Stream, Testrunde).
    if (open)
      untrack(() => {
        entwurfWeg();
        void starten();
      });
    return () => {
      untrack(() => {
        if (nimmtAuf) rekorder?.stop();
        cancelAnimationFrame(zeichenRahmen);
        clearInterval(rekordTimer);
        clearTimeout(wechselWache);
        wechselLaeuft = false;
        stream?.getTracks().forEach((t) => t.stop());
        stream = undefined;
      });
    };
  });

  const prozent = (wert: number, gesamt: number) =>
    gesamt > 0 ? Math.min(100, (wert / gesamt) * 100) : 0;
</script>

{#if open}
  <Portal>
    <div
      class="fixed inset-0 z-50 touch-none bg-black"
      data-testid="camera-overlay"
      role="application"
      ontouchstart={wischStart}
      ontouchend={wischEnde}
    >
      <!-- Live-Bild (versteckt sich, sobald ein Entwurf in der Vorschau ist) -->
      {#if !entwurfDatei}
        <video
          bind:this={video}
          autoplay
          playsinline
          muted
          class="size-full object-cover"
          onplaying={() => (liveLaeuft = true)}
          onloadeddata={() => (liveLaeuft = true)}
          oncanplay={() => (liveLaeuft = true)}
        ></video>

        {#if !liveLaeuft && !fehler}
          <div
            class="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-black"
            data-testid="camera-loading"
          >
            <LoaderCircleIcon class="text-primary size-8 animate-spin" />
            <span class="text-text-muted text-xs">{m.camera_startet()}</span>
          </div>
        {/if}

        {#if fehler}
          <div
            class="absolute inset-0 z-10 flex items-center justify-center p-6 text-center text-sm text-white"
          >
            {m.camera_nicht_verfuegbar()}
          </div>
        {/if}

        <!-- Kamera-Wechsel: das Standbild der alten Kamera bleibt stehen und
             verdeckt Lade-Loch wie Grau-Kästchen, bis der erste gezeichnete
             Frame der neuen Kamera dahinter steht (dann harter Schnitt). -->
        {#if wechselLaeuft}
          <canvas
            bind:this={wechselAnzeige}
            class="absolute inset-0 z-10 size-full object-cover"
            data-testid="camera-switch-frame"
          ></canvas>
        {/if}
      {:else}
        <!-- Entwurf-Vorschau: Foto als Bild, Video mit Player + Steuerung. -->
        {#if entwurfIstVideo}
          <!-- svelte-ignore a11y_media_has_caption, a11y_no_noninteractive_element_interactions -->
          <video
            bind:this={vorschau}
            src={entwurfUrl}
            autoplay
            loop
            playsinline
            class="absolute inset-0 z-10 size-full object-contain"
            ontimeupdate={() => (vorschauPosition = vorschau?.currentTime ?? 0)}
          ></video>
        {:else}
          <img src={entwurfUrl} alt="" class="absolute inset-0 z-10 size-full object-contain" />
        {/if}
      {/if}

      <!-- Kopfleiste -->
      <div class="absolute inset-x-0 top-0 z-20 flex items-center justify-between p-5">
        <button
          type="button"
          class="flex size-11 items-center justify-center rounded-full border border-white/10 bg-black/40 text-white backdrop-blur-md transition-transform active:scale-90"
          onclick={schliessen}
          aria-label={m.message_input_recording_discard()}
          data-testid="camera-overlay-close"
        >
          <XIcon class="size-5" />
        </button>
        <button
          type="button"
          class="flex size-12 items-center justify-center rounded-full border border-white/15 bg-black/50 text-white backdrop-blur-md transition-transform active:scale-95"
          onclick={() => void kameraWechseln()}
          aria-label="Kamera wechseln"
          data-testid="camera-overlay-flip"
        >
          <SwitchCameraIcon class="size-6" />
        </button>
      </div>

      <!-- Aufnahme-Timer -->
      {#if nimmtAuf}
        <div
          class="absolute left-1/2 top-6 z-20 flex -translate-x-1/2 items-center gap-2.5 rounded-full border border-white/10 bg-black/50 px-4 py-1.5 shadow-[0_0_24px_rgba(37,99,235,0.35)] backdrop-blur-md"
          data-testid="camera-overlay-timer"
        >
          <span class="bg-error size-2.5 animate-pulse rounded-full shadow-[0_0_8px_rgba(239,68,68,0.9)]"></span>
          <span class="text-sm font-semibold text-white tabular-nums">
            {formatiereDauer(rekordSekunden)}
          </span>
        </div>
      {/if}

      <!-- Untere Aktionszone. -->
      <div class="absolute inset-x-0 bottom-0 z-20 bg-gradient-to-t from-black/85 to-transparent px-6 pt-12 pb-8">
        {#if nimmtAuf}
          <!-- Aufnahme läuft: Modus gesperrt, Auslöser ist der Stopp. -->
          <div class="flex items-center justify-center">
            <button
              type="button"
              class="bg-error flex size-20 items-center justify-center rounded-full border-4 border-white/90 shadow-[0_0_36px_rgba(37,99,235,0.7)] transition-transform active:scale-95"
              onclick={() => rekorder?.stop()}
              data-testid="camera-stop"
            >
              <SquareIcon class="size-8 text-white" />
            </button>
          </div>
        {:else if entwurfDatei}
          <!-- Entwurf fertig: senden oder verwerfen. -->
          <div class="flex items-center justify-between">
            <button
              type="button"
              class="flex flex-col items-center gap-1.5 transition-transform active:scale-90"
              onclick={entwurfVerwerfen}
              data-testid="camera-discard"
            >
              <span class="flex size-14 items-center justify-center rounded-full border border-white/30 bg-white/10 backdrop-blur-md">
                <XIcon class="size-6 text-white" />
              </span>
              <span class="text-2xs font-semibold text-white/90">
                {m.message_input_recording_discard()}
              </span>
            </button>
            <button
              type="button"
              class="accent-gradient flex size-16 items-center justify-center rounded-full shadow-[0_8px_30px_rgba(37,99,235,0.5)] transition-transform active:scale-90"
              onclick={entwurfSenden}
              disabled={sendeLaeuft}
              data-testid="camera-send"
            >
              {#if sendeLaeuft}
                <LoaderCircleIcon class="size-7 animate-spin text-white" />
              {:else}
                <SendHorizontalIcon class="size-7 text-white" />
              {/if}
            </button>
          </div>
        {:else}
          <!-- Modus-Leiste ÜBER dem Auslöser: kompakt, antippbar UND wischbar
               — der aktive Modus ist weiß mit blauem Unterstrich, der
               inaktive gedimmt. -->
          <div
            class="absolute inset-x-0 bottom-44 z-20 flex items-center justify-center gap-6"
            data-testid="camera-mode-bar"
          >
            <button
              type="button"
              class="flex flex-col items-center gap-1 transition-colors {modus === 'foto'
                ? 'text-white'
                : 'text-white/40'}"
              onclick={() => (modus = 'foto')}
              data-testid="camera-mode-photo"
            >
              <span class="text-xs font-semibold">{m.message_input_anhang_foto()}</span>
              <span
                class="h-0.5 w-7 rounded-full {modus === 'foto' ? 'bg-primary' : 'bg-transparent'}"
              ></span>
            </button>
            <button
              type="button"
              class="flex flex-col items-center gap-1 transition-colors {modus === 'video'
                ? 'text-white'
                : 'text-white/40'}"
              onclick={() => (modus = 'video')}
              data-testid="camera-mode-video"
            >
              <span class="text-xs font-semibold">{m.message_input_anhang_video()}</span>
              <span
                class="h-0.5 w-7 rounded-full {modus === 'video' ? 'bg-primary' : 'bg-transparent'}"
              ></span>
            </button>
          </div>
          <!-- Bereit: Auslöser in der Mitte — Karte je Modus. -->
          <button
            type="button"
            class="relative mx-auto flex size-20 items-center justify-center rounded-full border-4 border-white/90 bg-black/70 shadow-[0_8px_30px_rgba(0,0,0,0.45)] transition-transform active:scale-95"
            onclick={modus === 'foto' ? schiessen : videoUmschalten}
            aria-label={modus === 'foto'
              ? m.message_input_take_photo()
              : m.message_input_anhang_video()}
            data-testid="camera-shutter"
          >
            {#if nimmtAuf}
              <!-- Blauer Puls-Ring um die Aufnahme (Testrunde 2026-09-23). -->
              <span
                class="pointer-events-none absolute -inset-3 animate-pulse rounded-full border-4 border-primary"
                data-testid="camera-pulse"
              ></span>
              <SquareIcon class="size-8 text-white" />
            {:else if modus === 'video'}
              <VideoIcon class="size-9 text-white" />
            {:else}
              <CameraIcon class="size-9 text-white" />
            {/if}
          </button>
        {/if}
      </div>
    </div>
  </Portal>
{/if}
