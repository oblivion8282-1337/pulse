/**
 * Gemeinsame Basis fürs Popup-Detach (HQ-Streams: `detach.svelte.ts`,
 * Watch-Party: `watchPartyDetach.svelte.ts`). Kapselt den verbatim
 * identischen Mechanismus:
 *   * reaktives Set der entkoppelten Keys,
 *   * BroadcastChannel-Sync ('close' Main→Popup, 'closed' Popup→Main),
 *   * 800-ms-Sweep, der geschlossene Popups aufräumt (Poll läuft nur,
 *     solange ≥ 1 Fenster getrackt wird),
 *   * Fensterzentrierung (1100×680, mittig im availWidth/Height),
 *   * Fokus/Reuse eines noch offenen Popups.
 *
 * Die Unterklassen liefern nur Key-/URL-/Payload-Bau und optional Hooks
 * (Watch-Party: sessionStorage-Suppress-Marker um `window.open`).
 */
export type DetachKind = 'close' | 'closed';

export type PopupDetacherOptions<A extends unknown[]> = {
  channelName: string;
  /** Composite key — eindeutig pro entkoppeltem Objekt. */
  key: (...args: A) => string;
  /** Wire-Payload für den BroadcastChannel (Form kompatibel zum Popup halten). */
  msg: (kind: DetachKind, ...args: A) => unknown;
  /** Argumente aus einer eingehenden Channel-Message zurückgewinnen. */
  parse: (m: Record<string, unknown>) => A | null;
  /** Popup-URL (inkl. Query-Parameter). */
  popupUrl: (...args: A) => string;
  /** Fenstername für `window.open` (bekommt den Key). */
  windowName: (k: string) => string;
};

export class PopupDetacher<A extends unknown[]> {
  protected set = $state<Set<string>>(new Set());
  // Popup-Fensterreferenzen, ungetrackt — werden nur lokal pro Tab gebraucht.
  protected windows = new Map<string, Window>();
  protected channel: BroadcastChannel | null = null;
  protected pollTimer: ReturnType<typeof setInterval> | null = null;
  protected opts: PopupDetacherOptions<A>;

  constructor(opts: PopupDetacherOptions<A>) {
    this.opts = opts;
    if (typeof window === 'undefined') return;
    this.channel = new BroadcastChannel(opts.channelName);
    this.channel.onmessage = (ev: MessageEvent) => {
      const m = ev.data;
      if (!m || typeof m !== 'object') return;
      if (m.kind === 'closed') {
        const args = opts.parse(m);
        if (args) this.markAttached(...args);
      }
    };
  }

  /** Start the sweep poll when the first popup is opened; stop when all are closed. */
  protected ensurePollRunning(): void {
    if (this.pollTimer === null && this.windows.size > 0) {
      this.pollTimer = setInterval(() => this.sweepClosedWindows(), 800);
    }
  }

  /** Stop the poll if no more windows are being tracked. */
  protected ensurePollStopped(): void {
    if (this.pollTimer !== null && this.windows.size === 0) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  has(...args: A): boolean {
    return this.set.has(this.opts.key(...args));
  }

  /** Hook für Unterklassen — Watch-Party setzt hier ihren Suppress-Marker. */
  protected beforeOpen(_k: string): void {}

  /** Öffnet das Popup-Fenster und markiert den Stream als entkoppelt.
   *  Wenn das Popup geblockt wird, wird nichts markiert und `false` zurückgegeben. */
  open(...args: A): boolean {
    const k = this.opts.key(...args);
    const existing = this.windows.get(k);
    if (existing && !existing.closed) {
      existing.focus();
      return true;
    }
    this.beforeOpen(k);
    const url = this.opts.popupUrl(...args);
    const w = 1100;
    const h = 680;
    const x = Math.round((window.screen.availWidth - w) / 2);
    const y = Math.round((window.screen.availHeight - h) / 2);
    const features = `popup=yes,width=${w},height=${h},left=${x},top=${y},resizable=yes`;
    const popup = window.open(url, this.opts.windowName(k), features);
    if (!popup) {
      this.onOpenAborted(k);
      return false; // Popup-Blocker
    }
    this.windows.set(k, popup);
    this.set = new Set(this.set).add(k);
    this.ensurePollRunning();
    return true;
  }

  /** Hook — Watch-Party räumt den Suppress-Marker, wenn `window.open` scheitert. */
  protected onOpenAborted(_k: string): void {}

  /** Hook beim Freiräumen eines Keys (markAttached / Sweep). */
  protected onKeyCleared(_k: string): void {}

  /** Schließt das Popup-Fenster (falls offen, im eigenen Tab geöffnet) und
   *  räumt den Detached-State sofort auf. Popups aus anderen Tabs werden
   *  über die Broadcast-Channel-Message 'close' aufgefordert sich zu schließen. */
  reattach(...args: A): void {
    const k = this.opts.key(...args);
    const w = this.windows.get(k);
    if (w && !w.closed) w.close();
    this.windows.delete(k);
    this.channel?.postMessage(this.opts.msg('close', ...args));
    this.markAttached(...args);
  }

  /** Vom Popup selbst aufgerufen wenn es geschlossen wird (`onbeforeunload`). */
  notifyClosed(...args: A): void {
    this.channel?.postMessage(this.opts.msg('closed', ...args));
  }

  /** Vom Popup abgefragt: soll ich mich schließen (z.B. Stream offline)? */
  onCloseRequest(cb: (...args: A) => void): () => void {
    if (!this.channel) return () => {};
    const ch = this.channel;
    const opts = this.opts;
    const handler = (ev: MessageEvent) => {
      const m = ev.data;
      if (m && m.kind === 'close') {
        const args = opts.parse(m);
        if (args) cb(...args);
      }
    };
    ch.addEventListener('message', handler);
    return () => ch.removeEventListener('message', handler);
  }

  protected markAttached(...args: A): void {
    const k = this.opts.key(...args);
    this.onKeyCleared(k);
    if (!this.set.has(k)) {
      this.ensurePollStopped();
      return;
    }
    const next = new Set(this.set);
    next.delete(k);
    this.set = next;
    this.ensurePollStopped();
  }

  protected sweepClosedWindows(): void {
    for (const [k, w] of this.windows) {
      if (w.closed) {
        this.windows.delete(k);
        this.onKeyCleared(k);
        if (this.set.has(k)) {
          const next = new Set(this.set);
          next.delete(k);
          this.set = next;
        }
      }
    }
    this.ensurePollStopped();
  }
}
