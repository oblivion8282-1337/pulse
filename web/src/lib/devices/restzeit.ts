/**
 * Wie lange gilt eine Freigabe noch?
 *
 * Bewusst ohne Importe: Nodes eingebauter Testläufer lädt diese Datei direkt,
 * und ein erweiterungsloser Laufzeit-Import (`from './nachbar'`) bräche dort.
 * Muster wie `lib/remote/zeigerbildPruefung.ts`.
 *
 * `null` heisst „dauerhaft" — nicht „unbekannt". Der Unterschied zu
 * `'abgelaufen'` ist wichtig: eine abgelaufene Freigabe steht weiter in der
 * Liste (der Server fegt nicht), und sie als „gilt noch 0 Minuten" zu zeigen
 * wäre die falsche Auskunft.
 *
 * **Struktur statt Text** (Fix zu Prüfbefund G-3, 2026-08-20): diese Datei
 * lieferte vorher fest deutsche Sätze ("45 Minuten", "2 Tage") — auf
 * englischer Oberfläche standen dann deutsche Zeitangaben, denn eine
 * importfreie Datei kann den Übersetzungskatalog nicht laden (der hängt an
 * Paraglide-Imports). Die Übersetzung passiert deshalb am Anzeigeort
 * (`DeviceFreigaben.svelte`), diese Funktion liefert nur noch Einheit und
 * Zahl.
 */
export type Restzeit = null | 'abgelaufen' | { einheit: 'minuten' | 'stunden' | 'tage'; anzahl: number };

export function restzeit(expiresAt: string | null, jetzt: number): Restzeit {
  if (expiresAt === null) return null;
  const ende = Date.parse(expiresAt);
  if (!Number.isFinite(ende)) return 'abgelaufen';
  const ms = ende - jetzt;
  if (ms <= 0) return 'abgelaufen';
  const minuten = Math.round(ms / 60_000);
  if (minuten < 60) return { einheit: 'minuten', anzahl: minuten };
  const stunden = Math.round(minuten / 60);
  if (stunden < 48) return { einheit: 'stunden', anzahl: stunden };
  return { einheit: 'tage', anzahl: Math.round(stunden / 24) };
}
