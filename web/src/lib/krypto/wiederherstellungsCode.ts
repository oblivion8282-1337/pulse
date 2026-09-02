/**
 * Der Wiederherstellungs-Code (E4).
 *
 * Formatwahl bewusst identisch zum vorhandenen MFA-Ersatzcode
 * (`services/auth/src/dcc_auth/recovery.py::generate_backup_codes`):
 * Grossbuchstaben-Hex. Zwei Gründe: das Haus hat damit schon ein
 * Codeformat, und Hex ist von sich aus verwechslungsfrei — das Alphabet
 * "0123456789ABCDEF" enthält kein O, kein I, kein l (die Buchstaben, mit
 * denen 0/1 sonst verwechselt werden, kommen im Hex-Alphabet gar nicht vor).
 *
 * Länge: 32 Hex-Zeichen = 128 Bit echter Zufall — die vom Plan geforderte
 * Untergrenze, aus der ohne Streckung direkt ein Schlüssel abgeleitet wird
 * (Begründung: Plandokument E4, Abschnitt "Zwei Entscheidungen").
 *
 * Anzeigeform: acht Vierergruppen mit Bindestrich, zum Abschreiben.
 *
 * WICHTIG: Der Code darf nirgends geloggt werden — auch nicht gekürzt,
 * auch nicht in einer Fehlermeldung. Diese Datei gibt deshalb bei
 * ungültiger Eingabe nur eine feste, code-freie Meldung zurück.
 */

const ALPHABET = '0123456789ABCDEF';
const ROH_LAENGE = 32; // Hex-Zeichen ohne Trenner = 128 Bit
const GRUPPEN_GROESSE = 4;

/** Erzeugt einen frischen Code in Anzeigeform (mit Gruppentrennern). */
export function erzeugeCode(): string {
  const bytes = new Uint8Array(ROH_LAENGE / 2);
  globalThis.crypto.getRandomValues(bytes);
  let roh = '';
  for (const b of bytes) {
    roh += b.toString(16).toUpperCase().padStart(2, '0');
  }
  return gruppiere(roh);
}

function gruppiere(roh: string): string {
  const gruppen: string[] = [];
  for (let i = 0; i < roh.length; i += GRUPPEN_GROESSE) {
    gruppen.push(roh.slice(i, i + GRUPPEN_GROESSE));
  }
  return gruppen.join('-');
}

export class CodeFehler extends Error {}

/**
 * Macht aus jeder plausiblen Schreibweise denselben Vergleichswert:
 * Gross-/Kleinschreibung, Leerraum (auch Zeilenumbrüche) und Bindestriche
 * sind egal, solange am Ende genau 32 Hex-Zeichen übrig bleiben.
 *
 * Wirft `CodeFehler`, wenn daraus kein gültiger Code wird — nie eine
 * "beste Vermutung" zurückgeben.
 */
export function normalisiere(eingabe: string): string {
  const bereinigt = eingabe
    .toUpperCase()
    .replace(/[\s-]+/g, '');

  if (bereinigt.length !== ROH_LAENGE) {
    throw new CodeFehler('ungültige Länge');
  }
  for (const zeichen of bereinigt) {
    if (!ALPHABET.includes(zeichen)) {
      throw new CodeFehler('unbekanntes Zeichen');
    }
  }
  return gruppiere(bereinigt);
}

/**
 * Die Rohbytes hinter einem normalisierten Code — Eingabe für die
 * Schlüsselableitung der Nachbaraufgabe.
 */
export function codeBytes(normalisiert: string): Uint8Array {
  const roh = normalisiert.replace(/-/g, '');
  const bytes = new Uint8Array(roh.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(roh.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}
