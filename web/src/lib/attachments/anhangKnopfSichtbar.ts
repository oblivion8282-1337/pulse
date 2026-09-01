/**
 * Ob die Büroklammer im Eingabefeld erscheint — importfrei, damit sie ohne
 * Svelte/Runes-Kompilierung prüfbar ist (s. CLAUDE.md „Zwei Fallen").
 *
 * Für DMs gilt seit 2026-08-29 die umgekehrte Reihenfolge: der Knopf ist
 * zuerst NICHT da und erscheint erst, sobald bekannt ist, dass das Gespräch
 * verschlüsselt läuft oder der Server den Klartext-Weg ausdrücklich erlaubt.
 * Ein permissiver Vorgabewert für „Auskunft noch unterwegs" wäre in der
 * Cloud (`cloud_dm_attachments_enabled = false`) fast immer falsch — die
 * Antwort lautet dort fast immer „nein", und ein kurz aufblitzender Knopf,
 * der gleich wieder verschwindet, ist schlechter als ein etwas später
 * erscheinender.
 *
 * **Seit Design §11.2 kommt eine zweite Bedingung dazu, und nur für den
 * VERSCHLÜSSELTEN Weg:** ein verschlüsselter Anhang landet im Cloud-Ordner
 * jedes Beteiligten, und wer keinen hat, kann ihn nicht empfangen. Fehlt
 * auch nur einem das Laufwerk, erscheint der Knopf gar nicht erst — statt
 * eines Knopfes, der scheitert.
 *
 * Der Klartext-Weg bleibt davon unberührt: dort hält Pulse die Bytes selbst,
 * es gibt kein fremdes Laufwerk, das fehlen könnte. Deshalb hängt
 * `laufwerkeBereit` ausschliesslich am Zweig `verschluesselt`.
 */
export function anhangKnopfSichtbar(
  headerKind: 'channel' | 'dm' | 'gruppe',
  verschluesselt: boolean,
  serverErlaubtKlartext: boolean | undefined,
  laufwerkeBereit: boolean | undefined
): boolean {
  if (headerKind === 'channel') return true;
  // Drei Zustände statt zwei, auf beiden Auskünften: `undefined` (Auskunft
  // noch unterwegs) und `false` (ausdrücklich nein) führen beide zu keinem
  // Knopf — nur ein strenges `true` schaltet ihn frei.
  if (verschluesselt) return laufwerkeBereit === true;
  // Eine private Gruppe hat keinen Klartext-Weg (Spec §9) — ohne
  // Verschlüsselung bleibt der Knopf dort aus, unabhängig vom Serverschalter.
  if (headerKind === 'gruppe') return false;
  return serverErlaubtKlartext === true;
}

/**
 * Warum der Knopf fehlt — damit die Oberfläche den Fall BENENNEN kann.
 *
 * §11.2 verlangt das ausdrücklich: „In einer Gruppe blockiert ein Mitglied
 * ohne Laufwerk die Anhänge für alle. Die Oberfläche muss das benennen, sonst
 * wirkt es unerklärlich." Ein blosses Ausgrauen wäre genau der stille
 * Fehlschlag, gegen den dieser Weg gebaut ist.
 *
 * `'kein-laufwerk'` meint: das Gespräch läuft verschlüsselt, aber mindestens
 * einer der Beteiligten hat kein Archiv-Laufwerk verbunden. `null` heisst
 * „nichts zu sagen" — entweder ist der Knopf da, oder sein Fehlen hat einen
 * Grund, den zu erklären niemandem hilft (Auskunft noch unterwegs, oder ein
 * Serverschalter, den der Nutzer ohnehin nicht umlegen kann).
 */
export function anhangKnopfGrund(
  headerKind: 'channel' | 'dm' | 'gruppe',
  verschluesselt: boolean,
  laufwerkeBereit: boolean | undefined
): 'kein-laufwerk' | null {
  if (headerKind === 'channel' || !verschluesselt) return null;
  return laufwerkeBereit === false ? 'kein-laufwerk' : null;
}

/**
 * Ob diese Datei die Grössengrenze einhält — reine Rechnung, damit sie
 * geprüft ist.
 *
 * **Vor dem Verschlüsseln zu fragen ist der ganze Punkt** (§11.3): sonst
 * käme die Absage erst nach Verschlüsseln und Hochladen, und der Nutzer
 * hätte auf einen Fehlschlag gewartet, der von Anfang an feststand.
 *
 * `undefined` (Grenze noch nicht bekannt) lässt durch — der Server weist
 * notfalls selbst mit 413 ab. Andersherum wäre der Knopf nach jedem
 * Neuladen kurz nutzlos, obwohl fast jede Datei passt.
 */
export function anhangGroesseOk(dateiGroesse: number, maxBytes: number | undefined): boolean {
  return maxBytes === undefined || dateiGroesse <= maxBytes;
}
