/**
 * Svelte-5-Runes-Zustand fuer den nativen HQ-Player: die Opt-in-Einstellung
 * (`useNativePlayer`, persistiert wie `stream/settings.svelte.ts`) und eine
 * Sitzungs-Klasse, die den `<video>`-freien Wiedergabepfad abbildet.
 *
 * Anders als `hqStreamManager.svelte.ts` haelt eine `NativePlayerSession`
 * KEINE eigene Verbindung zum Ton — der laeuft unveraendert ueber den
 * bestehenden `hqStreams`-Manager weiter (dessen Video-Element bleibt
 * dauerhaft stumm, der Ton kommt aus dem Web-Audio-Graphen, siehe
 * `hqStreamManager.svelte.ts`). Diese Sitzung ersetzt nur das BILD durch das
 * native Fenster.
 *
 * Registry-Muster (ensure/get/close/closeExcept) spiegelt `hqStreams` in
 * `hqStreamManager.svelte.ts`: `closeExcept()` ist die schliessende Haelfte von
 * `hqStreams.reconcile()` und wird von `HqStreamKeepAlive.svelte` direkt danach
 * aufgerufen. Das Oeffnen bleibt Sache von `WhepPlayer.svelte` (gated auf
 * `useNativePlayer` + `isPlayerAvailable()`) — die Kachel weiss, wann sie den
 * nativen Weg WILL; der Keep-Alive weiss nur, wann eine Kachel weg ist.
 */
import { chatApi } from '$lib/api/chat';
import { loadAll, saveAll } from '$lib/stream/persistence';
import type { PulsePlayerResult } from '$lib/platform/pulse.d';
import { closePlayer, onPlayerEvent, openPlayer, playerStats, type PlayerStateEvent } from './client';

// ── Einstellung (Default aus — experimentell, noch ohne Tonausgabe) ────────

export const playerSettings = $state({
  useNativePlayer: false,
  loaded: false,
});

/** Einmalig: persistierte Einstellung laden. Idempotent. */
export async function loadPlayerSettings(): Promise<void> {
  if (playerSettings.loaded) return;
  const data = await loadAll();
  if (typeof data.useNativePlayer === 'boolean') {
    playerSettings.useNativePlayer = data.useNativePlayer;
  }
  playerSettings.loaded = true;
}

export function setUseNativePlayer(v: boolean): void {
  playerSettings.useNativePlayer = v;
  void saveAll({ useNativePlayer: v });
}

// ── Sitzung ─────────────────────────────────────────────────────────────────

const STATS_POLL_MS = 1000;

export class NativePlayerSession {
  readonly channelId: string;
  readonly userId: string;
  readonly slot: number;

  phase = $state<PlayerStateEvent['state']>('connecting');
  error = $state<string | null>(null);
  stats = $state<PulsePlayerResult | null>(null);

  #session: number | null = null;
  #unlisten: (() => void) | null = null;
  #statsTimer: ReturnType<typeof setInterval> | undefined;
  #disposed = false;

  constructor(channelId: string, userId: string, slot = 0, title?: string) {
    this.channelId = channelId;
    this.userId = userId;
    this.slot = slot;
    this.#unlisten = onPlayerEvent((ev) => this.#onEvent(ev));
    void this.#open(title);
  }

  async #open(title?: string): Promise<void> {
    if (this.#disposed) return;
    this.phase = 'connecting';
    this.error = null;
    try {
      const { whep_url } = await chatApi.getWhepUrl(this.channelId, this.userId, this.slot);
      if (this.#disposed) return;
      const session = await openPlayer(whep_url, { title });
      if (this.#disposed) {
        if (session !== null) void closePlayer(session);
        return;
      }
      if (session === null) {
        this.phase = 'failed';
        this.error = 'native player: open fehlgeschlagen';
        return;
      }
      this.#session = session;
      this.#armStatsPoll();
    } catch (e) {
      if (this.#disposed) return;
      this.phase = 'failed';
      this.error = e instanceof Error ? e.message : String(e);
    }
  }

  /** Ein Event ohne `session` (main-seitiger Prozessabsturz, siehe
   *  `player.ts`'s `exit`-Handler) betrifft JEDE offene Sitzung. */
  #onEvent(ev: PlayerStateEvent): void {
    if (this.#disposed) return;
    if (ev.session !== undefined && ev.session !== this.#session) return;
    this.phase = ev.state;
    if (ev.error) this.error = ev.error;
    if (ev.state === 'closed' || ev.state === 'failed') this.#clearStatsPoll();
  }

  #armStatsPoll(): void {
    this.#clearStatsPoll();
    this.#statsTimer = setInterval(() => void this.#pollStats(), STATS_POLL_MS);
  }

  async #pollStats(): Promise<void> {
    if (this.#disposed || this.#session === null) return;
    const s = await playerStats(this.#session);
    if (this.#disposed) return;
    this.stats = s;
  }

  #clearStatsPoll(): void {
    clearInterval(this.#statsTimer);
    this.#statsTimer = undefined;
  }

  close(): void {
    this.#disposed = true;
    this.#clearStatsPoll();
    this.#unlisten?.();
    this.#unlisten = null;
    if (this.#session !== null) void closePlayer(this.#session);
    this.#session = null;
  }
}

// ── Registry ─────────────────────────────────────────────────────────────────

const registry = new Map<string, NativePlayerSession>();
const keyOf = (channelId: string, userId: string, slot: number): string => `${channelId}:${userId}:${slot}`;

export const nativePlayerSessions = {
  /** Bestehende Sitzung holen oder neu anlegen (idempotent). */
  ensure(channelId: string, userId: string, slot = 0, title?: string): NativePlayerSession {
    const k = keyOf(channelId, userId, slot);
    let s = registry.get(k);
    if (!s) {
      s = new NativePlayerSession(channelId, userId, slot, title);
      registry.set(k, s);
    }
    return s;
  },

  get(channelId: string, userId: string, slot = 0): NativePlayerSession | null {
    return registry.get(keyOf(channelId, userId, slot)) ?? null;
  },

  close(channelId: string, userId: string, slot = 0): void {
    const k = keyOf(channelId, userId, slot);
    const s = registry.get(k);
    if (s) {
      s.close();
      registry.delete(k);
    }
  },

  /** Schliesst jede Sitzung, deren Schluessel NICHT in `wanted` steht — die
   *  schliessende Haelfte von `hqStreams.reconcile()`, ohne dessen oeffnende
   *  Haelfte: geoeffnet wird ausschliesslich vom `WhepPlayer`-Effect, gated auf
   *  `useNativePlayer` + `isPlayerAvailable()`. */
  closeExcept(wanted: { channelId: string; userId: string; slot: number }[]): void {
    const wantedKeys = new Set(wanted.map((w) => keyOf(w.channelId, w.userId, w.slot)));
    for (const k of [...registry.keys()]) {
      if (!wantedKeys.has(k)) {
        registry.get(k)!.close();
        registry.delete(k);
      }
    }
  },
};
