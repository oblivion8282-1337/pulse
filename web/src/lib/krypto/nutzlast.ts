/**
 * Baut die Bytes, ueber die das Geraet mit seinem Anmeldeschluessel (Ed25519,
 * `keypairStore`) unterschreibt, bevor es Schluessel veroeffentlicht.
 *
 * MUSS zeichengenau (byte fuer byte) mit dem Server uebereinstimmen:
 * `services/chat-gateway/src/dcc_chat_gateway/schluessel_nachweis.py::baue_nutzlast`.
 * Eine Abweichung um ein einziges Byte ergibt beim Server 403, ohne dass die
 * Fehlermeldung sagt, woran es lag — deshalb der Byte-Test gegen ein aus dem
 * Backend kopiertes Beispiel (`krypto-nutzlast.test.ts`).
 *
 * Bauvorschrift (aus `baue_nutzlast`): KONTEXT + 0x00 + Zweck + 0x00 + Teil_1 +
 * 0x00 + Teil_2 + ... — Kontext und Zweck feste ASCII-Bytes, jeder Teil
 * einzeln UTF-8-kodiert, alle Stuecke durch genau EIN Nullbyte getrennt.
 *
 * Importfrei, damit Nodes eingebauter Testlaeufer die Datei ohne Bundler
 * pruefen kann (s. CLAUDE.md „Die Falle").
 */

/** Trennt diese Nutzlast von jedem anderen Ed25519-Signaturverfahren im
 *  Projekt (z. B. die Cert-Login-Challenge) — muss WORTGLEICH mit
 *  `_KONTEXT` in `schluessel_nachweis.py` uebereinstimmen. */
const KONTEXT = 'pulse-schluessel-nachweis-v1';

export function baueNutzlast(zweck: string, ...teile: string[]): Uint8Array {
  const encoder = new TextEncoder();
  const stuecke = [encoder.encode(KONTEXT), encoder.encode(zweck)];
  for (const teil of teile) {
    stuecke.push(encoder.encode(teil));
  }

  const laenge = stuecke.reduce((summe, s) => summe + s.length, 0) + (stuecke.length - 1);
  const ergebnis = new Uint8Array(laenge);
  let offset = 0;
  stuecke.forEach((stueck, index) => {
    ergebnis.set(stueck, offset);
    offset += stueck.length;
    if (index < stuecke.length - 1) {
      // Nullbyte-Trenner — kommt in keinem Base64-Alphabet vor.
      ergebnis[offset] = 0x00;
      offset += 1;
    }
  });
  return ergebnis;
}
