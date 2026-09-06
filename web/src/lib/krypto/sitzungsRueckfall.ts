/**
 * Eine eingehende Zustellung oeffnen — mit Rueckfall auf den Sitzungsaufbau.
 *
 * Importfrei, damit `pnpm test:unit` es prueft (s. CLAUDE.md, Node-Laeufer).
 * Die Entscheidung steht hier, die Krypto und der Speicher bleiben in
 * `zustellungOeffnen.ts`.
 *
 * **Der Fehler, den das schliesst (2026-09-03, Cloud):** zu einem
 * Absendergeraet gibt es lokal genau EINE Sitzung. Lag eine vor, wurde nur
 * sie versucht — und schlug sie fehl, blieb der Umschlag still liegen, auch
 * wenn er ein SITZUNGSAUFBAU (Art 0) war, der eine neue Sitzung eroeffnen
 * kann. Genau das passiert nach jeder Neuanmeldung: die Gegenseite baut
 * eine frische Sitzung auf, hier liegt noch die alte, und ab da kann keine
 * Seite die andere mehr lesen. Beide Richtungen sassen so fest, jede
 * Zustellung blieb unquittiert, kein Fehler wurde irgendwo sichtbar.
 *
 * Olm/Matrix machen es genauso: bestehende Sitzung zuerst, und ein
 * Pre-Key-Umschlag, den sie nicht oeffnet, gruendet eine neue.
 */

export interface Geoeffnet<S> {
  sitzung: S;
  klartext: Uint8Array;
  /** `true` = die Sitzung ist neu und muss ATOMAR mit dem Konto gesichert
   *  werden (der Einmalschluessel ist verbraucht). */
  neu: boolean;
}

/**
 * `vorhanden` ist die gespeicherte Sitzung oder `null`; `oeffnen` versucht
 * sie; `aufbauen` ist der Sitzungsaufbau aus dem Umschlag oder `null`, wenn
 * der Umschlag keiner ist (Art != 0) oder der Identitaetsschluessel fehlt.
 *
 * Rueckgabe `null` = nicht zu oeffnen, liegen lassen. Ein Fehler aus
 * `aufbauen` wird NICHT geschluckt — er ist der Befund, den die Diagnose
 * braucht, und der Aufrufer entscheidet.
 */
export function oeffneMitRueckfall<S>(
  vorhanden: S | null,
  oeffnen: (sitzung: S) => Uint8Array,
  aufbauen: (() => { sitzung: S; klartext: Uint8Array }) | null
): Geoeffnet<S> | null {
  if (vorhanden) {
    try {
      return { sitzung: vorhanden, klartext: oeffnen(vorhanden), neu: false };
    } catch (err) {
      if (!aufbauen) throw err;
      // Die alte Sitzung passt nicht — beim Sitzungsaufbau weiter.
    }
  }
  if (!aufbauen) return null;
  const neu = aufbauen();
  return { sitzung: neu.sitzung, klartext: neu.klartext, neu: true };
}
