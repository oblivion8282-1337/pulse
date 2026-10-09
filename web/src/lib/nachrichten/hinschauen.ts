/**
 * Schaut der Nutzer gerade auf die App? Erst dann gilt eine Nachricht im
 * offenen Gespräch als gelesen (Befund 2026-10-10).
 *
 * Bis dahin reichte „das Gespräch ist offen": wer Pulse auf einer DM stehen
 * liess und das Fenster minimierte (oder am Handy die App wechselte, solange
 * die Verbindung noch stand), las jede neue Nachricht sofort — der Absender
 * sah Blau, und der Empfänger bekam aus der App weder Ton noch Hinweis noch
 * Zähler, weil die Nachricht ja als gelesen galt.
 *
 * Dieselbe Grenze wie die Benachrichtigungen (`notifications/inPage.ts`:
 * „im Hintergrund" = verborgen ODER ohne Fokus) — was dort eine
 * Benachrichtigung auslöst, darf hier nicht als gelesen zählen.
 */
export function siehtHin(): boolean {
  if (typeof document === 'undefined') return true;
  return document.visibilityState === 'visible' && document.hasFocus();
}

/** Ruft `rueckruf`, sobald der Nutzer (wieder) hinschaut — Fenster bekommt
 *  den Fokus oder wird sichtbar. Gibt die Abmeldung zurück. */
export function beimHinschauen(rueckruf: () => void): () => void {
  if (typeof window === 'undefined') return () => {};
  const pruefen = () => {
    if (siehtHin()) rueckruf();
  };
  window.addEventListener('focus', pruefen);
  document.addEventListener('visibilitychange', pruefen);
  return () => {
    window.removeEventListener('focus', pruefen);
    document.removeEventListener('visibilitychange', pruefen);
  };
}
