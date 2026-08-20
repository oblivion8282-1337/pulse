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
 */
export function restzeit(expiresAt: string | null, jetzt: number): string | null {
  if (expiresAt === null) return null;
  const ende = Date.parse(expiresAt);
  if (!Number.isFinite(ende)) return 'abgelaufen';
  const ms = ende - jetzt;
  if (ms <= 0) return 'abgelaufen';
  const minuten = Math.round(ms / 60_000);
  if (minuten < 60) return `${minuten} Minuten`;
  const stunden = Math.round(minuten / 60);
  if (stunden < 48) return `${stunden} Stunden`;
  return `${Math.round(stunden / 24)} Tage`;
}
