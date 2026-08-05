/**
 * Umschaltlogik zwischen dem nativen HQ-Player und dem bestehenden
 * `<video>`-WHEP-Weg fuer EINE Stream-Kachel — ausgelagert aus
 * `WhepPlayer.svelte` (Groessen-Policy, PLAN.md §12.1).
 *
 * Der native Player ersetzt nur das BILD; der Ton laeuft unveraendert ueber
 * den bestehenden `hqStreams`-Manager (dessen Video-Element ist immer stumm,
 * der Ton kommt aus dem Web-Audio-Graphen — siehe hqStreamManager.svelte.ts).
 * Scheitert die native Sitzung (`state:"failed"`), faellt die Kachel
 * automatisch und dauerhaft (bis zum naechsten Mount) auf den `<video>`-Weg
 * zurueck.
 */
import { isElectron } from '$lib/platform/runtime';
import type { StreamPhase } from '../stream/hqStreamManager.svelte';
import { isPlayerAvailable } from './client';
import {
  loadPlayerSettings,
  nativePlayerSessions,
  nativeWindowRequests,
  playerSettings,
  type NativePlayerSession,
} from './store.svelte';

export interface NativePlaybackArgs {
  channelId: string;
  userId: string;
  slot: number;
  title?: string;
  /**
   * Sendet dieser Stream mit 10 bit? Dann gibt es fuer den Zuschauer keine
   * Wahl — s. `erzwungen` unten.
   */
  tenBit?: boolean;
}

/** `args` bleibt eine Funktion (kein Objekt), damit Aenderungen an den
 *  Feldern (z.B. `streamSlot`-Prop-Wechsel) reaktiv mitgetrackt werden. */
export function useNativePlayback(args: () => NativePlaybackArgs): {
  readonly active: boolean;
  /** Wie `ManagedHqStream.phase` (hqStreamManager.svelte.ts) — der Aufrufer
   *  kann Overlay/HUD unveraendert weiterverwenden, egal welcher Weg aktiv ist. */
  readonly phase: StreamPhase;
  readonly detail: string;
  /** Die laufende Sitzung — Traeger der Messwerte und der Fernsteuerung
   *  (Lautstaerke, Fenster nach vorne). `null`, solange keine laeuft. */
  readonly session: NativePlayerSession | null;
  /** Das eigene Fenster laeuft, weil der Stream es verlangt — nicht, weil der
   *  Zuschauer es gewaehlt hat. Die Kachel sagt das dazu; ein Schalter, der
   *  sichtbar nichts bewirkt, sieht sonst kaputt aus. */
  readonly erzwungen: boolean;
  /** Steht das eigene Fenster ueberhaupt zur Verfuegung (Electron + Binary)?
   *  Die Kachel braucht das fuer ihren Abkoppel-Knopf: ohne das Fenster fuehrt
   *  er in das zweite Browser-Fenster wie eh und je. Hier mit heraus, damit
   *  die Kachel `isPlayerAvailable()` nicht ein zweites Mal fragen muss. */
  readonly verfuegbar: boolean;
  /** Native Sitzung ist (bis zum naechsten Mount) endgueltig gescheitert. Der
   *  Abkoppel-Knopf muss das kennen: ohne native Sitzung fuehrt er wieder ins
   *  zweite Browser-Fenster statt sichtbar nichts zu tun. */
  readonly nativeFailed: boolean;
} {
  let nativeAvailable = $state(false);
  let nativeFailed = $state(false);
  /** Der Stream passt nicht zur Einstellung `onlyTenBit` → kein eigenes
   *  Fenster (s. `NativePlayerSession`). Seit 2026-07-28 nur noch, wenn diese
   *  Einstellung ausdruecklich gesetzt ist; sonst gehen alle Codecs und
   *  Bittiefen ins Fenster. */
  let nativeSkipped = $state(false);

  $effect(() => {
    void loadPlayerSettings();
    if (isElectron()) void isPlayerAvailable().then((v) => (nativeAvailable = v));
  });

  /**
   * 10 bit laesst dem Zuschauer keine Wahl.
   *
   * Der `<video>`-Weg kann es nicht darstellen: Chromium legt seinen Puffer
   * immer als 8 bit an — auch mit aktivem HDR und `scrgb-linear`, gemessen am
   * 2026-07-26. Bliebe die Kachel dort, saehe der Zuschauer den Stream nur
   * heruntergerechnet, ohne dass ihm etwas sagt, warum.
   *
   * Der Zwang greift NUR, wenn das Fenster auch wirklich zur Verfuegung steht.
   * Fehlt das Binary oder ist die Sitzung gescheitert, bleibt es beim
   * `<video>`-Weg — ein heruntergerechnetes Bild ist immer noch besser als gar
   * keins.
   */
  const verfuegbar = $derived(isElectron() && nativeAvailable);

  const erzwungen = $derived(verfuegbar && !nativeFailed && args().tenBit === true);

  /**
   * Hat der Zuschauer DIESEN Stream ins eigene Fenster geschickt?
   *
   * Das ist seit dem zusammengelegten Abkoppel-Knopf der uebliche Weg.
   * `useNativePlayer` bleibt daneben als Vorgabe-fuer-alles bestehen (ohne
   * Oberflaeche, s. `pulse-stream.json`) — wer den gesetzt hat, bekommt jeden
   * Stream im Fenster, ohne zu klicken.
   */
  const angefordert = $derived(
    nativeWindowRequests.has(args().channelId, args().userId, args().slot)
  );

  const active = $derived(
    verfuegbar &&
      (angefordert || playerSettings.useNativePlayer || erzwungen) &&
      !nativeFailed &&
      !nativeSkipped
  );

  let session = $state<NativePlayerSession | null>(null);
  $effect(() => {
    if (!active) {
      session = null;
      return;
    }
    const a = args();
    session = nativePlayerSessions.ensure(a.channelId, a.userId, a.slot, a.title);
  });

  // Kein automatischer Retry hier — ist der native Player einmal gescheitert,
  // bleibt die Kachel bis zum naechsten Mount beim <video>-Weg (derselbe
  // Stream neu ueber den Player zu versuchen wuerde denselben Fehler nur
  // wiederholen, z.B. ein zu altes Binary oder ein kaputter Codec-Pfad).
  // 8-bit-Stream: still auf den `<video>`-Weg zurueck. Bewusst OHNE Warnung —
  // das ist der Normalfall und kein Fehler.
  $effect(() => {
    if (session?.skipped) nativeSkipped = true;
  });

  $effect(() => {
    if (session?.phase === 'failed') {
      console.warn(
        '[whep-player] nativer Player gescheitert, Rueckfall auf <video>:',
        session.error,
      );
      nativeFailed = true;
    }
  });

  // Auf den `ManagedHqStream`-Phasenraum abgebildet, damit der Aufrufer
  // Overlay/HUD unveraendert weiterverwenden kann (siehe StreamPhase oben).
  const phase = $derived<StreamPhase>(
    session?.phase === 'playing'
      ? 'playing'
      : session?.phase === 'failed'
        ? 'error'
        : session?.phase === 'stalled'
          ? 'retrying'
          : 'connecting'
  );
  const detail = $derived(session?.error ?? '');

  return {
    get active() {
      return active;
    },
    get phase() {
      return phase;
    },
    get detail() {
      return detail;
    },
    get session() {
      return session;
    },
    get erzwungen() {
      return erzwungen;
    },
    get verfuegbar() {
      return verfuegbar;
    },
    get nativeFailed() {
      return nativeFailed;
    },
  };
}
