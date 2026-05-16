/**
 * Detach-Streams: ein HQ-Stream-Player kann in ein zweites Fenster/Tab
 * abgekoppelt werden. Der Player im Hauptfenster wird dann durch einen
 * Placeholder ersetzt — wichtig, damit die WHEP-Verbindung dort wirklich
 * abgebaut wird (kein doppeltes Subscriben + doppelte Bandbreite).
 *
 * Sync zwischen Haupt- und Popup-Fenster läuft über `BroadcastChannel`:
 *   * main  → popup: `{ kind: 'close', cid, uid }`   (stream geht offline)
 *   * popup → main:  `{ kind: 'closed', cid, uid }`  (popup wurde geschlossen)
 *
 * Wir verfolgen geöffnete Popup-Fensterreferenzen lokal (nur im
 * eigenen Tab gültig) damit „Fenster fokussieren" / „Schließen" funktioniert.
 */
const KEY_SEP = '';
const CHANNEL_NAME = 'pulse:stream-detach';

function keyOf(cid: string, uid: string): string {
  return `${cid}${KEY_SEP}${uid}`;
}

type DetachMessage =
  | { kind: 'closed'; cid: string; uid: string }
  | { kind: 'close'; cid: string; uid: string };

class DetachedStreams {
  #set = $state<Set<string>>(new Set());
  // Popup-Fensterreferenzen, ungetrackt — werden nur lokal pro Tab gebraucht.
  #windows = new Map<string, Window>();
  #channel: BroadcastChannel | null = null;
  #pollTimer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    if (typeof window === 'undefined') return;
    this.#channel = new BroadcastChannel(CHANNEL_NAME);
    this.#channel.onmessage = (ev: MessageEvent<DetachMessage>) => {
      const m = ev.data;
      if (!m || typeof m !== 'object') return;
      if (m.kind === 'closed') this.#markAttached(m.cid, m.uid);
    };
    // Poll: window-references erkennen geschlossene Popups (z.B. via OS-X)
    // sicherer als nur 'closed'-Message, weil Popup beim Crash nichts mehr sendet.
    this.#pollTimer = setInterval(() => this.#sweepClosedWindows(), 800);
  }

  has(cid: string, uid: string): boolean {
    return this.#set.has(keyOf(cid, uid));
  }

  /** Öffnet das Popup-Fenster und markiert den Stream als entkoppelt.
   *  Wenn das Popup geblockt wird, wird nichts markiert und `false` zurückgegeben. */
  open(cid: string, uid: string): boolean {
    const k = keyOf(cid, uid);
    const existing = this.#windows.get(k);
    if (existing && !existing.closed) {
      existing.focus();
      return true;
    }
    const url = `/stream-popup/${encodeURIComponent(cid)}/${encodeURIComponent(uid)}`;
    const w = 1100;
    const h = 680;
    const x = Math.round((window.screen.availWidth - w) / 2);
    const y = Math.round((window.screen.availHeight - h) / 2);
    const features = `popup=yes,width=${w},height=${h},left=${x},top=${y},resizable=yes`;
    const popup = window.open(url, `pulse-stream-${k}`, features);
    if (!popup) return false; // Popup-Blocker
    this.#windows.set(k, popup);
    this.#set = new Set(this.#set).add(k);
    return true;
  }

  /** Schließt das Popup-Fenster (falls offen, im eigenen Tab geöffnet) und
   *  räumt den Detached-State sofort auf. Popups aus anderen Tabs werden
   *  über die Broadcast-Channel-Message 'close' aufgefordert sich zu schließen. */
  reattach(cid: string, uid: string): void {
    const k = keyOf(cid, uid);
    const w = this.#windows.get(k);
    if (w && !w.closed) w.close();
    this.#windows.delete(k);
    this.#channel?.postMessage({ kind: 'close', cid, uid } satisfies DetachMessage);
    this.#markAttached(cid, uid);
  }

  /** Vom Popup selbst aufgerufen wenn es geschlossen wird (`onbeforeunload`). */
  notifyClosed(cid: string, uid: string): void {
    this.#channel?.postMessage({ kind: 'closed', cid, uid } satisfies DetachMessage);
  }

  /** Vom Popup abgefragt: soll ich mich schließen (z.B. Stream offline)? */
  onCloseRequest(cb: (cid: string, uid: string) => void): () => void {
    if (!this.#channel) return () => {};
    const ch = this.#channel;
    const handler = (ev: MessageEvent<DetachMessage>) => {
      const m = ev.data;
      if (m && m.kind === 'close') cb(m.cid, m.uid);
    };
    ch.addEventListener('message', handler);
    return () => ch.removeEventListener('message', handler);
  }

  #markAttached(cid: string, uid: string): void {
    const k = keyOf(cid, uid);
    if (!this.#set.has(k)) return;
    const next = new Set(this.#set);
    next.delete(k);
    this.#set = next;
  }

  #sweepClosedWindows(): void {
    for (const [k, w] of this.#windows) {
      if (w.closed) {
        this.#windows.delete(k);
        if (this.#set.has(k)) {
          const next = new Set(this.#set);
          next.delete(k);
          this.#set = next;
        }
      }
    }
  }
}

export const detachedStreams = new DetachedStreams();
