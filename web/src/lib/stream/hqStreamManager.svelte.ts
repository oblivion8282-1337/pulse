/**
 * Dauerhafter Halter für eine HQ-WHEP-Wiedergabe — überlebt das Wegnavigieren.
 *
 * Problem vorher: Die WHEP-Verbindung (RTCPeerConnection + MediaStream) lebte
 * IN der `WhepPlayer`-Komponente. Beim Verlassen des Channel-Bildschirms (z.B.
 * in eine DM) unmountete der Player → Verbindung gekappt → beim Zurückkommen
 * voller Reconnect (~1-2 s + evtl. Wackler).
 *
 * Jetzt: Die Verbindung + der Audio-Graph gehören diesem Manager, der NICHT am
 * Bildschirm hängt. Der Ton läuft über den Web-Audio-Graphen weiter, auch wenn
 * gerade kein `<video>` gemountet ist. Kommt der Viewer zurück, hängt der
 * Player nur sein Video-Element wieder an den schon laufenden MediaStream →
 * Bild sofort da, kein Reconnect.
 *
 * Lebensdauer wird vom `openedTiles`-Zustand bestimmt (siehe
 * `HqStreamKeepAlive.svelte`), NICHT vom Mounten/Unmounten des Players:
 * geschlossen wird, wenn der Viewer die Kachel zumacht ODER den Voice-Channel
 * verlässt/wechselt.
 *
 * Das Video ist IMMER stumm — der Ton kommt ausschließlich aus dem Web-Audio-
 * Graphen (`VolumeBoost`) bzw. dem Fallback-`<audio>`-Element. Dadurch ist der
 * Ton vom Video-Element entkoppelt und läuft beim Wegnavigieren weiter.
 */
import { connectWhep, WhepError, type WhepSession } from './whep';
import { WhepStatsReader, type StreamStats } from './whep-stats';
import { VolumeBoost } from './volumeBoost';
import { getStreamVolume, setStreamVolume } from './streamVolume';
import { chatApi } from '$lib/api/chat';

// Retry-Backoff: Publisher evtl. noch nicht online (404) oder transienter
// Netz-Aussetzer. ICE-Watchdog wie zuvor im WhepPlayer.
const RETRY_MS = [1000, 2000, 3000, 5000, 5000];
const CONNECT_TIMEOUT_MS = 7000;

export type StreamPhase = 'connecting' | 'playing' | 'retrying' | 'error';

export class ManagedHqStream {
  readonly channelId: string;
  readonly userId: string;
  /** Which of the user's streams this plays (0 = primary, 1 = a second one). */
  readonly slot: number;

  phase = $state<StreamPhase>('connecting');
  detail = $state<string>('');
  stats = $state<StreamStats | null>(null);
  audioBlocked = $state(false);
  /** Eingehender MediaStream — das Player-`<video>` hängt sich hier dran. */
  stream = $state<MediaStream | null>(null);
  volume = $state(100);

  #session: WhepSession | null = null;
  #connListener: ((this: RTCPeerConnection, ev: Event) => void) | null = null;
  #retryTimer: ReturnType<typeof setTimeout> | undefined;
  #connectTimer: ReturnType<typeof setTimeout> | undefined;
  #statsTimer: ReturnType<typeof setInterval> | undefined;
  #statsReader = new WhepStatsReader();
  #boost = new VolumeBoost();
  // Fallback-Audiosenke, falls der Web-Audio-Graph nicht greift (kein
  // AudioContext / kein Audio-Track) — bleibt auch ohne Video am Leben.
  #audioEl: HTMLAudioElement | null = null;
  #attempt = 0;
  #disposed = false;
  #videoEl: HTMLVideoElement | null = null;
  // Letzte Nicht-Null-Lautstärke für den Mute-Toggle.
  #prevVolume = 100;

  constructor(channelId: string, userId: string, slot = 0) {
    this.channelId = channelId;
    this.userId = userId;
    this.slot = slot;
    const v = getStreamVolume(userId);
    this.volume = v;
    this.#prevVolume = v > 0 ? v : 100;
    this.#boost.onStateChange = (suspended) => {
      this.audioBlocked = suspended;
    };
    void this.#start();
  }

  // ---- Video-Anbindung (Bild) --------------------------------------------
  attachVideo(el: HTMLVideoElement): void {
    this.#videoEl = el;
    if (this.stream) {
      el.srcObject = this.stream;
      el.muted = true; // Ton läuft über den Web-Audio-Graphen, nie übers Video.
      void el.play().catch(() => {});
    }
  }

  detachVideo(el: HTMLVideoElement): void {
    if (this.#videoEl === el) {
      el.srcObject = null;
      this.#videoEl = null;
    }
  }

  // ---- Lautstärke ---------------------------------------------------------
  setVolume(v: number): void {
    if (v > 0) this.#prevVolume = v;
    this.volume = v;
    this.#applyVolume();
    setStreamVolume(this.userId, v);
  }

  toggleMute(): void {
    const next = this.volume > 0 ? 0 : this.#prevVolume > 0 ? this.#prevVolume : 100;
    if (this.volume > 0) this.#prevVolume = this.volume;
    this.setVolume(next);
  }

  async enableAudio(): Promise<void> {
    try {
      await this.#boost.resume();
      await this.#audioEl?.play();
      this.audioBlocked = this.#boost.suspended;
    } catch {
      /* still blocked */
    }
  }

  #applyVolume(): void {
    const v = this.volume / 100;
    if (this.#audioEl) this.#audioEl.volume = Math.min(1.0, v);
    this.#boost.setVolume(v);
  }

  // ---- Audio-Senke --------------------------------------------------------
  #ensureAudioEl(): HTMLAudioElement {
    if (!this.#audioEl) {
      const el = document.createElement('audio');
      el.autoplay = true;
      el.style.display = 'none';
      document.body.appendChild(el);
      this.#audioEl = el;
    }
    return this.#audioEl;
  }

  #removeAudioEl(): void {
    if (this.#audioEl) {
      this.#audioEl.srcObject = null;
      this.#audioEl.remove();
      this.#audioEl = null;
    }
  }

  #onStream(stream: MediaStream): void {
    if (this.#disposed) return;
    this.stream = stream;
    // Audio bevorzugt über den Web-Audio-Graphen (boost) — läuft unabhängig vom
    // Video-Element weiter. Greift der nicht, Fallback auf ein verstecktes,
    // ungemutetes <audio>-Element (auch dauerhaft, ohne Video).
    if (this.#boost.attach(stream)) {
      this.audioBlocked = this.#boost.suspended;
      this.#removeAudioEl();
    } else {
      const el = this.#ensureAudioEl();
      el.srcObject = stream;
      el.muted = false;
      void el.play().catch(() => {});
    }
    if (this.#videoEl) {
      this.#videoEl.srcObject = stream;
      this.#videoEl.muted = true;
      void this.#videoEl.play().catch(() => {});
    }
    this.#applyVolume();
  }

  // ---- WHEP-Verbindung (aus WhepPlayer übernommen) ------------------------
  #clearTimers(): void {
    clearTimeout(this.#retryTimer);
    this.#retryTimer = undefined;
    clearTimeout(this.#connectTimer);
    this.#connectTimer = undefined;
    clearInterval(this.#statsTimer);
    this.#statsTimer = undefined;
  }

  async #teardown(): Promise<void> {
    this.#clearTimers();
    const s = this.#session;
    this.#session = null;
    if (s && this.#connListener) {
      s.pc.removeEventListener('connectionstatechange', this.#connListener);
    }
    this.#connListener = null;
    if (s) await s.close();
  }

  #scheduleRetry(): void {
    if (this.#disposed) return;
    const wait = RETRY_MS[Math.min(this.#attempt, RETRY_MS.length - 1)];
    this.#attempt += 1;
    this.phase = 'retrying';
    this.#retryTimer = setTimeout(() => {
      this.#retryTimer = undefined;
      void this.#start();
    }, wait);
  }

  async #start(): Promise<void> {
    if (this.#disposed) return;
    await this.#teardown();
    if (this.#disposed) return;
    if (this.#attempt === 0) this.phase = 'connecting';
    try {
      const { whep_url } = await chatApi.getWhepUrl(this.channelId, this.userId, this.slot);
      if (this.#disposed) return;
      const s = await connectWhep(whep_url, (stream) => this.#onStream(stream));
      if (this.#disposed) {
        await s.close();
        return;
      }
      this.#session = s;
      const onConnected = () => {
        clearTimeout(this.#connectTimer);
        this.#connectTimer = undefined;
        this.#attempt = 0;
        this.phase = 'playing';
        this.detail = '';
      };
      const recycle = () => {
        void this.#teardown().then(() => {
          if (!this.#disposed) this.#scheduleRetry();
        });
      };
      this.#connListener = () => {
        if (this.#disposed || this.#session !== s) return;
        const st = s.pc.connectionState;
        // `disconnected` ist transient (Chromium erholt sich meist) — nur bei
        // den endgültigen Zuständen neu aufbauen.
        if (st === 'connected') onConnected();
        else if (st === 'failed' || st === 'closed') recycle();
      };
      s.pc.addEventListener('connectionstatechange', this.#connListener);
      if (s.pc.connectionState === 'connected') {
        onConnected();
      } else {
        this.#connectTimer = setTimeout(() => {
          this.#connectTimer = undefined;
          if (this.#disposed || this.#session !== s) return;
          if (s.pc.connectionState !== 'connected') recycle();
        }, CONNECT_TIMEOUT_MS);
      }
      this.#statsReader.reset();
      this.#statsTimer = setInterval(async () => {
        const cur = this.#session;
        if (!cur) return;
        const next = await this.#statsReader.read(cur.pc);
        // Während des read()-Awaits kann ein Reconnect (teardown→start) den
        // Session-PeerConnection ausgetauscht oder den Manager entsorgt haben —
        // dann gehören die Stats zum alten PC, nicht überschreiben.
        if (this.#disposed || this.#session !== cur) return;
        this.stats = next;
      }, 1000);
    } catch (e) {
      if (this.#disposed) return;
      const status = e instanceof WhepError ? e.status : 0;
      this.detail = e instanceof Error ? e.message : String(e);
      if (status === 404 || status === 0 || status >= 500) {
        this.#scheduleRetry();
      } else {
        this.phase = 'error';
      }
    }
  }

  close(): void {
    this.#disposed = true;
    void this.#teardown();
    this.#boost.dispose();
    this.#removeAudioEl();
    this.stream = null;
  }
}

// ---- Registry -------------------------------------------------------------

const registry = new Map<string, ManagedHqStream>();
const keyOf = (channelId: string, userId: string, slot: number) =>
  `${channelId}:${userId}:${slot}`;

export const hqStreams = {
  /** Bestehenden Manager holen oder neu anlegen (idempotent). */
  ensure(channelId: string, userId: string, slot = 0): ManagedHqStream {
    const k = keyOf(channelId, userId, slot);
    let m = registry.get(k);
    if (!m) {
      m = new ManagedHqStream(channelId, userId, slot);
      registry.set(k, m);
    }
    return m;
  },

  get(channelId: string, userId: string, slot = 0): ManagedHqStream | null {
    return registry.get(keyOf(channelId, userId, slot)) ?? null;
  },

  close(channelId: string, userId: string, slot = 0): void {
    const k = keyOf(channelId, userId, slot);
    const m = registry.get(k);
    if (m) {
      m.close();
      registry.delete(k);
    }
  },

  /**
   * Soll-Zustand abgleichen: für jeden gewünschten Stream (channel, user, slot)
   * einen Manager sicherstellen, alle übrigen schließen. Treiber = `openedTiles`
   * (siehe `HqStreamKeepAlive.svelte`).
   */
  reconcile(wanted: { channelId: string; userId: string; slot: number }[]): void {
    const wantedKeys = new Set(wanted.map((w) => keyOf(w.channelId, w.userId, w.slot)));
    for (const k of [...registry.keys()]) {
      if (!wantedKeys.has(k)) {
        registry.get(k)!.close();
        registry.delete(k);
      }
    }
    for (const w of wanted) this.ensure(w.channelId, w.userId, w.slot);
  }
};
