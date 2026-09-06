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

/**
 * WAS an der Wand-Stelle zu sehen ist, wenn sie ueberhaupt steht (B11,
 * 2026-09-02): In einer App (Electron oder Android-Huelle) hat der Nutzer
 * sein Geraet schon in der Hand — „Apps herunterladen" waere dorthin ein
 * Witz, und das Einrichten ist DIESEM Geraet moeglich. Deshalb dort die
 * Einrichtung anbieten (und beim Erscheinen der Wand selbst anstossen, s.
 * `geraeteEinrichtung.ts`). Im Browser bleibt es bei der alten Wand
 * (Regel d4cd6aee: der Browser braucht eine Kopplung, kein Auto-Setup —
 * ein losloser Tab zaehlt als Geraet nicht, Spec §3a).
 *
 * Importfrei wie `dmOhneAppGeraet`, deren Kriterium sie nur fachelt.
 */
export type Wandart = 'keine' | 'einrichtung' | 'apps';

export function wandEntscheidung(
  featureSchalterEin: boolean,
  appKontext: boolean,
  eigenerStand: boolean | undefined
): Wandart {
  if (!dmOhneAppGeraet(featureSchalterEin, eigenerStand)) return 'keine';
  return appKontext ? 'einrichtung' : 'apps';
}
