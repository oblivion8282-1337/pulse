/**
 * Nachrichten-Entwürfe pro Channel — gilt für Guild-Channels UND DMs (der
 * Schlüssel ist die Channel-ID, DM-Channels haben ihre eigene). Discord-
 * Verhalten: tippen → Channel/Tab wechseln → zurückkommen → Text steht noch.
 *
 * Persistiert als EIN localStorage-Key (überlebt Reload/Update), gerätelokal.
 * Entwürfe sind Nachrichtentexte und damit user-gebunden sensibel → bei
 * Sign-Out/Account-Wechsel werden sie über ``resetSocialStores()`` komplett
 * geleert (gleiche Klasse wie der frühere ``pulse.servers``-Account-Leak).
 *
 * LRU-Kappung auf ``MAX_DRAFTS`` (Objekt-Insertion-Order, Re-Insert beim
 * Schreiben); Persist ist debounced (ein Write pro Tipp-Pause statt pro
 * Tastendruck) mit pagehide-Flush, damit ein Reload mitten im Satz nichts
 * verliert.
 */

const KEY = 'pulse.drafts';
const MAX_DRAFTS = 200;
const PERSIST_DELAY_MS = 400;

function load(): Record<string, string> {
  try {
    return JSON.parse(window.localStorage.getItem(KEY) ?? '{}') as Record<string, string>;
  } catch {
    return {};
  }
}

class DraftsStore {
  #map = $state<Record<string, string>>(typeof window === 'undefined' ? {} : load());
  #timer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    // Debounce-Fenster darf einen Reload nicht überleben — letzte Eingaben
    // sonst weg, genau wenn man "kurz F5 drückt".
    if (typeof window !== 'undefined') {
      window.addEventListener('pagehide', () => this.#persistNow());
    }
  }

  get(channelId: string): string {
    return this.#map[channelId] ?? '';
  }

  set(channelId: string, text: string): void {
    if (!text.trim()) {
      this.clear(channelId);
      return;
    }
    if (this.#map[channelId] === text) return;
    // Re-Insert ans Ende → Insertion-Order als LRU für die Kappung.
    const { [channelId]: _evicted, ...rest } = this.#map;
    const entries = Object.entries(rest);
    while (entries.length >= MAX_DRAFTS) entries.shift();
    this.#map = Object.fromEntries([...entries, [channelId, text]]);
    this.#schedulePersist();
  }

  clear(channelId: string): void {
    if (!(channelId in this.#map)) return;
    const { [channelId]: _evicted, ...rest } = this.#map;
    this.#map = rest;
    this.#schedulePersist();
  }

  /** Sign-Out/Account-Wechsel: Entwürfe des Vorgängers restlos entfernen. */
  clearAll(): void {
    this.#map = {};
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    try {
      window.localStorage.removeItem(KEY);
    } catch {
      /* ignore */
    }
  }

  #schedulePersist(): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = setTimeout(() => this.#persistNow(), PERSIST_DELAY_MS);
  }

  #persistNow(): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    try {
      window.localStorage.setItem(KEY, JSON.stringify(this.#map));
    } catch {
      /* ignore — volle Quota o.ä. kostet nur die Persistenz, nicht den Text */
    }
  }
}

export const drafts = new DraftsStore();
