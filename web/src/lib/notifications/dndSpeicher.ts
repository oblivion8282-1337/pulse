/**
 * Spiegelt den eigenen DND-Status nach IndexedDB (`pulse_presence/status:dnd`).
 *
 * Bughunt Runde 19: der Service-Worker liest dieses Flag für
 * geschlossene-Browser-Pushes — geschrieben hat es bisher NUR der
 * StatusPicker-Klick. Server-Truth (ready-Seed, presence_status_changed
 * von einem Zweitgerät, Sign-Out-Reset) ließ das Flag stale: DND auf
 * Gerät B → Gerät A schaufelte weiter Pushes durch; oder schlimmer,
 * einmal gesetztes DND blieb nach Sign-Out `true` und schluckte ALLE
 * Pushes, obwohl DND längst aus war.
 *
 * Both StatusPicker and the presence-store server-truth paths call this.
 */
export function schreibeDndNachIdb(dnd: boolean): void {
  try {
    const req = indexedDB.open('pulse_presence', 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore('status');
    };
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction('status', 'readwrite');
      tx.objectStore('status').put(dnd, 'dnd');
    };
  } catch {
    /* IndexedDB not available (SSR / private mode) — skip */
  }
}
