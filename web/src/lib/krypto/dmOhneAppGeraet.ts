/**
 * Ob der DM-Bildschirm durch den „du brauchst ein App-Geraet"-Hinweis
 * ersetzt wird — importfrei, damit sie ohne Svelte/Runes-Kompilierung
 * pruefbar ist (s. CLAUDE.md „Zwei Fallen").
 *
 * Hintergrund ist Spec §3a, Punkt 1: ein Konto ohne Desktop-/Mobil-App und
 * ohne gekoppelten Browser kann weder senden noch empfangen. Wer in diesem
 * Zustand die Direktnachrichten oeffnet, darf keine leere Liste sehen.
 *
 * `eigenerStand` kommt aus derselben Route wie das Schloss-Kennzeichen der
 * Gegenstelle (`krypto/schloss.svelte.ts`), nur mit der eigenen Konto-ID
 * abgefragt — `GET /keys/verschluesselbar/{ziel_id}` erlaubt das eigene
 * Konto ausdruecklich (`schluessel_zugriff.py::darf_schluessel_holen`) und
 * verbraucht nichts. Drei Zustaende, wie dort:
 *
 * * `undefined` — die Auskunft ist noch unterwegs oder wurde noch nicht
 *   angefragt. Zeigt NICHT den neuen Bildschirm: ein kurz aufblitzender
 *   „du brauchst die App"-Hinweis bei jemandem, der laengst eines hat, waere
 *   schlimmer als ein spaeter erscheinender richtiger Zustand.
 * * `true` — mindestens ein dauerhaftes eigenes Geraet hat Schluessel
 *   veroeffentlicht. Normale Ansicht.
 * * `false` — kein dauerhaftes eigenes Geraet. Hinweisbildschirm.
 *
 * Der Schalter bleibt die aeussere Bedingung, wie bei `dmSendeSperre`: bei
 * ausgeschaltetem `E2E_DMS_ENABLED` laeuft jede DM den Klartext-Weg, und der
 * Hinweis waere schlicht falsch.
 */
export function dmOhneAppGeraet(
  featureSchalterEin: boolean,
  eigenerStand: boolean | undefined
): boolean {
  return featureSchalterEin && eigenerStand === false;
}
