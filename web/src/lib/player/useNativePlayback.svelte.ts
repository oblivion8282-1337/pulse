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
  playerSettings,
  type NativePlayerSession,
} from './store.svelte';

export interface NativePlaybackArgs {
  channelId: string;
  userId: string;
  slot: number;
  title?: string;
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
} {
  let nativeAvailable = $state(false);
  let nativeFailed = $state(false);
  /** Der Stream ist 8 bit → kein eigenes Fenster (s. `NativePlayerSession`). */
  let nativeSkipped = $state(false);

  $effect(() => {
    void loadPlayerSettings();
    if (isElectron()) void isPlayerAvailable().then((v) => (nativeAvailable = v));
  });

  const active = $derived(
    isElectron() &&
      nativeAvailable &&
      playerSettings.useNativePlayer &&
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
  };
}
