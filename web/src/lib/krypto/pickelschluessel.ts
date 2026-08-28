/**
 * Leitet den 32-Byte-Schluessel ab, mit dem der vodozemac-Account
 * eingefroren wird (`Identitaet.einfrieren`).
 *
 * Importfrei, damit Nodes eingebauter Testlaeufer die Datei ohne Bundler
 * pruefen kann (s. CLAUDE.md „Die Falle").
 *
 * Nimmt bewusst die fertige Signatur entgegen statt sie selbst zu erzeugen:
 * das Signieren braucht den Geraeteschluessel (Ed25519, `extractable: false`)
 * und gehoert damit in ein Modul, das WebCrypto importieren darf. Diese
 * Datei bleibt so importfrei und im Node-Laeufer pruefbar.
 */
export async function pickelschluesselAbleiten(signatur: ArrayBuffer): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest('SHA-256', signatur);
  return new Uint8Array(digest);
}
