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
  import FastForwardIcon from '@lucide/svelte/icons/fast-forward';
  import LoaderCircleIcon from '@lucide/svelte/icons/loader-circle';
  import PauseIcon from '@lucide/svelte/icons/pause';
  import PlayIcon from '@lucide/svelte/icons/play';
  import RewindIcon from '@lucide/svelte/icons/rewind';
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
    // ZWINGEND zuerst: den Frame-Wächter des ALTEN Kamerastarts löschen,
    // bevor das Standbild hochgeht — sonst sieht der Schnitt-Effekt unten
    // „Standbild da + Frame da“ und nimmt es sofort wieder weg (der schwarze
    // Blitz, den der erste Versuch hatte).
    ersteFrameDa = false;
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
  let vorschauWache = 0;

  // Schnitt (WhatsApp-Prinzip): Spulleiste oben, zwei Griffe markieren den
  // Bereich, der beim Senden übrig bleibt. Geschnitten wird in Echtzeit —
  // der Entwurf läuft von Start bis Ende durch einen MediaRecorder
  // (ponytail: echte Sekunden statt Frame-genauer Neukodierung; ein
  // ffmpeg.wasm wäre der Ausbau, lohnt erst bei langen Videos).
  let vorschauDauer = $state(0);
  let schnittStart = $state(0);
  let schnittEnde = $state(0);
  let spurlauf: 'start' | 'ende' | null = null;
  /** Der antippbare Griff: ausgewählt = weiß, und die ±10-s-Knöpfe
   *  verschieben dann IHN in 1-s-Schritten, statt zu spulen. */
  let gewaehlterGriff: 'start' | 'ende' | null = $state(null);
  let schneideLaeuft = $state(false);
  let spur: HTMLDivElement | undefined = $state();

  function spule(sekunden: number): void {
    if (!vorschau || !vorschauDauer) return;
    vorschau.currentTime = Math.min(
      vorschauDauer,
      Math.max(0, vorschau.currentTime + sekunden)
    );
  }

  /** Die ±10-s-Knöpfe: ohne gewählten Griff spulen sie wie gehabt, mit
   *  gewähltem Griff schieben sie DIESEN in 1-SEKUNDEN-Schritten — die
   *  Vorschau springt zum neuen Schnittpunkt mit. */
  function griffNudge(sekunden: number): void {
    if (!vorschau || !vorschauDauer) return;
    if (!gewaehlterGriff) {
      spule(sekunden);
      return;
    }
    const schritt = Math.sign(sekunden); // gewählt = fein: 1 s je Tipp
    if (gewaehlterGriff === 'start') {
      schnittStart = Math.min(vorschauDauer, Math.max(0, schnittStart + schritt));
      schnittStart = Math.min(schnittStart, schnittEnde - 0.3);
      vorschau.currentTime = schnittStart;
    } else {
      schnittEnde = Math.max(0, Math.min(vorschauDauer, schnittEnde + schritt));
      schnittEnde = Math.max(schnittEnde, schnittStart + 0.3);
      vorschau.currentTime = schnittEnde;
    }
  }

  function spurTippen(e: PointerEvent): void {
    if (spurlauf || !vorschau || !spur || !vorschauDauer) return;
    gewaehlterGriff = null; // abseits der Griffe getippt → Auswahl lösen
    const rect = spur.getBoundingClientRect();
    vorschau.currentTime =
      Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width)) * vorschauDauer;
  }

  function griffFassen(art: 'start' | 'ende') {
    return (e: PointerEvent) => {
      spurlauf = art;
      gewaehlterGriff = art;
      vorschau?.pause();
      e.stopPropagation(); // nicht zugleich als Track-Tipp werten
      (e.currentTarget as Element).setPointerCapture(e.pointerId);
    };
  }

  // svelte-ignore a11y_no_static_element_interactions
  function griffBewegen(e: PointerEvent): void {
    if (!spurlauf || !spur || !vorschau || !vorschauDauer) return;
    const rect = spur.getBoundingClientRect();
    const zeit =
      Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width)) * vorschauDauer;
    // 0.3 s Mindestschnipsel — ein unbeabsichtigter Nullschnitt nutzt nichts.
    if (spurlauf === 'start') {
      schnittStart = Math.min(zeit, schnittEnde - 0.3);
    } else {
      schnittEnde = Math.max(zeit, schnittStart + 0.3);
    }
    // Die Vorschau springt zum Griff, damit man den Schnittpunkt SIEHT.
    vorschau.currentTime = spurlauf === 'start' ? schnittStart : schnittEnde;
  }

  function griffLoslassen(): void {
    spurlauf = null;
  }

  /** Schneidet in Echtzeit: der Entwurf läuft von schnittStart bis
   *  schnittEnde, MediaRecorder nimmt den Element-Stream mit Ton auf. */
  async function schnittAnwenden(): Promise<File> {
    if (!vorschau || !entwurfDatei) throw new Error('kein Entwurf');
    const mime = entwurfDatei.type || 'video/webm';
    // captureStream fehlt im TS-lib-Dom — existiert in jedem Chromium/WebView.
    const strom = (
      vorschau as HTMLVideoElement & { captureStream(): MediaStream }
    ).captureStream();
    const teile: Blob[] = [];
    const rekorder = new MediaRecorder(strom, { mimeType: mime });
    const fertig = new Promise<Blob>((resolve) => {
      rekorder.ondataavailable = (e) => {
        if (e.data.size > 0) teile.push(e.data);
      };
      rekorder.onstop = () => resolve(new Blob(teile, { type: mime.split(';')[0] }));
    });
    vorschau.currentTime = schnittStart;
    await new Promise<void>((resolve) => {
      vorschau!.onseeked = () => resolve();
      setTimeout(resolve, 1000); // Notfall: ohne seeked nicht ewig warten
    });
    rekorder.start();
    void vorschau.play();
    await new Promise<void>((resolve) => {
      const wache = setInterval(() => {
        if (!vorschau || vorschau.paused || vorschau.currentTime >= schnittEnde - 0.03) {
          clearInterval(wache);
          resolve();
        }
      }, 50);
    });
    vorschau.pause();
    rekorder.stop();
    const blob = await fertig;
    const datei = new File([blob], `kamera-video-${Date.now()}.webm`, { type: blob.type });
    // Dauer für die Empfänger-Anzeige ist jetzt die des SCHNITTS.
    aufnahmeDauerRegister.set(datei, Math.round(schnittEnde - schnittStart));
    return datei;
  }

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
    vorschauDauer = 0;
    schnittStart = 0;
    schnittEnde = 0;
    gewaehlterGriff = null;
    cancelAnimationFrame(vorschauWache);
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
    // kennt — nicht das zu frühe „playing“). liveLaeuft kommt hier mit hoch,
    // damit nach dem Schnitt keine Lade-Fläche nachblitzt.
    if (wechselLaeuft && ersteFrameDa) {
      wechselLaeuft = false;
      liveLaeuft = true;
    }
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
    // Kamera-Wechsel läuft: das Video-Element zeigt beim Stream-Tausch
    // schwarz — den Frame NICHT zeichnen, der Canvas hält das letzte Bild
    // und der Rekorder bekommt ein Standbild statt eines schwarzen Blocks.
    // ponytail: eingefrorene Stelle statt hartem Schnitt im File — ein
    // nahtloser Schnitt bräuchte Recorder-Neustart + Stitchen zweier Dateien.
    if (!wechselLaeuft && zeichenLeinwand && video && video.videoWidth) {
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

  /** YouTube-Prinzip in der Entwurf-Vorschau: Tippen aufs Video schaltet
   *  zwischen Abspielen und Pause um — der Play-Kreis in der Mitte zeigt
   *  sich nur im Stillstand. Ein Schnittpunkt gilt dabei: außerhalb des
   *  Bereichs gestartet wird auf schnittStart zurückgespult. */
  function vorschauUmschalten(): void {
    if (!vorschau || schneideLaeuft) return;
    if (vorschau.paused) {
      if (
        vorschau.currentTime < schnittStart - 0.02 ||
        vorschau.currentTime > schnittEnde - 0.02
      ) {
        vorschau.currentTime = schnittStart;
      }
      void vorschau.play().catch(() => {});
    } else {
      vorschau.pause();
    }
  }

  /** Hält die Vorschau IM Schnittbereich: erreicht die Wiedergabe den
   *  Endgriff, stoppt sie und rollt zum Startgriff zurück — ein 10-s-Video
   *  auf 5 s geschnitten zeigt genau diese 5 s, nicht dahinter weiter. */
  function vorschauWacheStarten(): void {
    cancelAnimationFrame(vorschauWache);
    if (!vorschau) return;
    const schritt = () => {
      if (!vorschau || vorschau.paused) return;
      if (vorschau.currentTime >= schnittEnde - 0.02) {
        vorschau.pause();
        vorschau.currentTime = schnittStart;
        return;
      }
      vorschauWache = requestAnimationFrame(schritt);
    };
    vorschauWache = requestAnimationFrame(schritt);
  }

  /** Erster GEZEICHNETER Frame der Vorschau — bis er steht, deckt Schwarz
   *  das graue WebView-Kästchen (dasselbe Muster wie beim Live-Bild; ein
   *  pausiertes Video dekodiert von allein gar nichts). Der Mini-Seek auf
   *  0.001 zwingt den Dekodierer, Frame 1 wirklich zu liefern. */
  function vorschauFrameAbwarten(el: HTMLVideoElement): void {
    const mitCallback = el as HTMLVideoElement & {
      requestVideoFrameCallback?: (cb: () => void) => number;
    };
    if (mitCallback.requestVideoFrameCallback) {
      mitCallback.requestVideoFrameCallback(() => (vorschauBereit = true));
    } else if (el.readyState >= 2) {
      vorschauBereit = true;
    } else {
      el.onloadeddata = () => (vorschauBereit = true);
    }
  }

  async function entwurfSenden(): Promise<void> {
    if (!entwurfDatei || schneideLaeuft) return;
    let datei = entwurfDatei;
    // Nur dann wirklich schneiden, wenn jemand an den Griffen war — der
    // ungeschnittene Entwurf geht ohne Echtzeit-Neukodierung raus.
    const ungeschnitten =
      schnittStart <= 0.05 && schnittEnde >= vorschauDauer - 0.05;
    if (!ungeschnitten) {
      schneideLaeuft = true;
      try {
        datei = await schnittAnwenden();
      } catch {
        /* schneiden fehlgeschlagen → das ganze Video geht raus */
      }
      schneideLaeuft = false;
    }
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
        <!-- Entwurf-Vorschau: Foto als Bild, Video YouTube-artig — Tippen
             aufs Video startet/pausiert, Play-Kreis nur im Stillstand. -->
        {#if entwurfIstVideo}
          <!-- svelte-ignore a11y_media_has_caption, a11y_no_noninteractive_element_interactions -->
          <video
            bind:this={vorschau}
            src={entwurfUrl}
            playsinline
            preload="auto"
            class="absolute inset-0 z-10 size-full object-contain {vorschauBereit ? 'opacity-100' : 'opacity-0'}"
            onclick={vorschauUmschalten}
            onloadedmetadata={(e) => {
              const el = e.currentTarget as HTMLVideoElement;
              vorschauDauer = el.duration || 0;
              schnittStart = 0;
              schnittEnde = vorschauDauer;
              vorschauFrameAbwarten(el);
              if (!el.currentTime) el.currentTime = 0.001;
            }}
            ontimeupdate={() => (vorschauPosition = vorschau?.currentTime ?? 0)}
            onplay={() => {
              vorschauLaeuft = true;
              vorschauWacheStarten();
            }}
            onpause={() => {
              vorschauLaeuft = false;
              cancelAnimationFrame(vorschauWache);
            }}
            onended={() => {
              // natürliches Ende (auch am Schnittrand): zurück zum Start
              if (vorschau) vorschau.currentTime = schnittStart;
            }}
          ></video>
          {#if !vorschauBereit}
            <!-- deckt das graue Kästchen, bis Frame 1 gezeichnet ist -->
            <div class="absolute inset-0 z-10 bg-black"></div>
          {/if}
          {#if !vorschauLaeuft && vorschauBereit}
            <button
              type="button"
              class="absolute left-1/2 top-1/2 z-20 flex size-14 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border-2 border-white/80 bg-black/60"
              onclick={vorschauUmschalten}
              aria-label={m.audio_player_play()}
              data-testid="camera-draft-play"
            >
              <PlayIcon class="size-7 text-white" />
            </button>
          {/if}
          {#if vorschauBereit && !schneideLaeuft}
            <!-- Spul-/Schnittleiste oben (WhatsApp-Prinzip): Timeline in
                 voller Breite, darunter die ±Knöpfe um die Zeitanzeige.
                 Tippen auf einen Griff wählt ihn aus (weiß); die ±Knöpfe
                 verschieben dann IHN in 1-s-Schritten, ohne Auswahl spulen
                 sie ±10 s. -->
            <div class="absolute inset-x-0 top-0 z-20 px-8 pt-[34px]" data-testid="camera-draft-trim">
              <!-- svelte-ignore a11y_no_static_element_interactions -->
              <div
                bind:this={spur}
                class="relative h-8 touch-none"
                onpointerdown={spurTippen}
                onpointermove={griffBewegen}
                onpointerup={griffLoslassen}
                onpointercancel={griffLoslassen}
              >
                <div class="absolute inset-x-0 top-1/2 h-1.5 -translate-y-1/2 rounded-full bg-white/25"></div>
                <div
                  class="absolute top-1/2 h-1.5 -translate-y-1/2 rounded-full bg-primary"
                  style="left: {prozent(schnittStart, vorschauDauer)}%; width: {prozent(
                    schnittEnde - schnittStart,
                    vorschauDauer
                  )}%;"
                ></div>
                <!-- Schnitt-Griffe: antippen wählt aus (weiß), die
                     ±Knöpfe verschieben dann in 1-s-Schritten -->
                <div
                  class="absolute top-1/2 size-6 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 shadow-lg {gewaehlterGriff === 'start'
                    ? 'border-white bg-white'
                    : 'border-white bg-black/70'}"
                  style="left: {prozent(schnittStart, vorschauDauer)}%"
                  onpointerdown={griffFassen('start')}
                  data-testid="camera-trim-start"
                ></div>
                <div
                  class="absolute top-1/2 size-6 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 shadow-lg {gewaehlterGriff === 'ende'
                    ? 'border-white bg-white'
                    : 'border-white bg-black/70'}"
                  style="left: {prozent(schnittEnde, vorschauDauer)}%"
                  onpointerdown={griffFassen('ende')}
                  data-testid="camera-trim-end"
                ></div>
              </div>
              <div class="mt-1 flex items-center justify-center gap-8">
                <button
                  type="button"
                  class="flex size-10 items-center justify-center rounded-full border border-white/10 bg-black/40 text-white backdrop-blur-md transition-transform active:scale-90"
                  onclick={() => griffNudge(-10)}
                  aria-label={gewaehlterGriff
                    ? 'Schnittmarke 1 Sekunde nach links'
                    : '10 Sekunden zurück'}
                  data-testid="camera-draft-rewind"
                >
                  <RewindIcon class="size-5" />
                </button>
                <span class="text-2xs text-white/80 tabular-nums" data-testid="camera-draft-time">
                  {formatiereDauer(vorschauPosition)} / {formatiereDauer(vorschauDauer)}
                </span>
                <button
                  type="button"
                  class="flex size-10 items-center justify-center rounded-full border border-white/10 bg-black/40 text-white backdrop-blur-md transition-transform active:scale-90"
                  onclick={() => griffNudge(10)}
                  aria-label={gewaehlterGriff
                    ? 'Schnittmarke 1 Sekunde nach rechts'
                    : '10 Sekunden vor'}
                  data-testid="camera-draft-forward"
                >
                  <FastForwardIcon class="size-5" />
                </button>
              </div>
            </div>
          {/if}
        {:else}
          <img src={entwurfUrl} alt="" class="absolute inset-0 z-10 size-full object-contain" />
        {/if}
      {/if}

      <!-- Kopfleiste (pt bewusst 6 px unter den Standard-20 px: die Knöpfe
           klebten sonst an der Statusleiste des Handys — Nutzerwunsch).
           Im Entwurf bewusst WEG: dort wäre das ✕ nur das zweite ✕ neben
           dem Verwerfen-Knopf, und ein Kamera-Wechsel über dem Entwurf
           wäre tote UI. -->
      {#if !entwurfDatei}
        <div class="absolute inset-x-0 top-0 z-20 flex items-center justify-between px-5 pt-[26px] pb-5">
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
      {/if}

      <!-- Aufnahme-Timer (gleicher Riegel wie die Kopfleiste: ~1 mm tiefer) -->
      {#if nimmtAuf}
        <div
          class="absolute left-1/2 top-[30px] z-20 flex -translate-x-1/2 items-center gap-2.5 rounded-full border border-white/10 bg-black/50 px-4 py-1.5 shadow-[0_0_24px_rgba(37,99,235,0.35)] backdrop-blur-md"
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
              onclick={() => void entwurfSenden()}
              disabled={sendeLaeuft || schneideLaeuft}
              data-testid="camera-send"
            >
              {#if sendeLaeuft || schneideLaeuft}
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
