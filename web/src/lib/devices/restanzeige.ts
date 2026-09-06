/**
 * Der übersetzte Restzeit-Text aus der `Restzeit`-Struktur.
 *
 * Die Minuten/Stunden/Tage-Konstruktion stand doppelt (`DeviceFreigaben`,
 * `SettingsStandplatz`) — und `SettingsStandplatz` rechnete die Schwellen
 * sogar ein drittes Mal nach. Sie liegen jetzt allein in `restzeit`, diese
 * Datei macht nur noch den letzten Schritt Struktur → Text.
 *
 * Bewusst **nicht** in `restzeit.ts`: jene Datei bleibt importfrei (direkter
 * Lauf in Node-Tests, siehe ihren Kopf-Kommentar), der Übersetzungskatalog
 * hier aber ist ein Import.
 */
import { m } from '$lib/paraglide/messages.js';
import type { Restzeit } from './restzeit';

type Gelaufend = Exclude<Restzeit, null | 'abgelaufen'>;

export function restText(rest: Gelaufend): string {
  if (rest.einheit === 'minuten') return m.standplatz_rest_minutes({ count: rest.anzahl });
  if (rest.einheit === 'stunden') return m.standplatz_rest_hours({ count: rest.anzahl });
  return m.standplatz_rest_days({ count: rest.anzahl });
}
