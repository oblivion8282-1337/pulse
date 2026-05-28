/**
 * Inkognito/Private-Browsing-Detection.
 *
 * Methode: `navigator.storage.persist()` — im normalen Modus gibt
 * persist() `true` zurück, in Inkognito-Modus oder Browsern ohne
 * Persistent-Storage-Unterstützung gibt es `false` zurück.
 *
 * Wichtig: Das ist eine Heuristik. Firefox gibt auch im normalen
 * Modus `false` zurück wenn kein Permission-Grant vorliegt. Wir
 * nutzen es als "Storage ist NICHT persistent — Keypair könnte verloren gehen"
 * Warnung, nicht als harter Blocker.
 *
 * Zusätzliche Heuristik (IndexedDB-Quota-Test): In Safari Inkognito
 * ist die Quote stark limitiert. Wir versuchen dort einen kleinen Write.
 */

/**
 * Prüft ob der Browser im Private-/Inkognito-Modus läuft.
 *
 * Returns:
 *  - `true`  = Inkognito erkannt oder Storage nicht persistent (Keypair-Verlust-Risiko)
 *  - `false` = Normaler Modus mit persistentem Storage
 */
export async function isPrivateBrowsing(): Promise<boolean> {
  if (typeof navigator === 'undefined') return false;

  // Methode 1: navigator.storage.persist() (Chrome/Firefox/Edge)
  if ('storage' in navigator && 'persist' in navigator.storage) {
    try {
      const persistent = await navigator.storage.persist();
      if (!persistent) return true;
    } catch {
      // API existiert aber wirft — vorsichtshalber als privat behandeln
      return true;
    }
  }

  // Methode 2: IndexedDB-Quota-Test (Safari Inkognito ≤ 5MB-Limit)
  if (typeof indexedDB !== 'undefined') {
    try {
      if ('estimate' in navigator.storage) {
        const { quota } = await navigator.storage.estimate();
        // Safari Inkognito hat typischerweise < 10MB Quota
        if (quota !== undefined && quota < 10 * 1024 * 1024) return true;
      }
    } catch {
      // Ignorieren
    }
  }

  return false;
}

// Gecachtes Ergebnis damit wiederholte Aufrufe nicht jedes Mal async sind
let _cachedResult: boolean | null = null;
let _probe: Promise<boolean> | null = null;

/**
 * Wie `isPrivateBrowsing()`, aber cached nach erstem Aufruf.
 */
export function getPrivateBrowsingState(): Promise<boolean> {
  if (_cachedResult !== null) return Promise.resolve(_cachedResult);
  if (_probe) return _probe;
  _probe = isPrivateBrowsing().then((v) => {
    _cachedResult = v;
    return v;
  });
  return _probe;
}

/** Setzt den Cache zurück (für Tests). */
export function resetPrivateBrowsingCache(): void {
  _cachedResult = null;
  _probe = null;
}
