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

/** Trennt die neue Ableitung von jeder anderen, die dasselbe Geheimnis je
 *  leisten koennte. Die `v2` steht fuer die QUELLE (krypto-eigenes Geheimnis
 *  statt Anmeldeschluessel), nicht fuer ein anderes Verfahren. */
const PICKLE_KONTEXT_V2 = 'pulse-krypto-pickle-v2';

/**
 * Leitet denselben 32-Byte-Schluessel aus dem krypto-eigenen Geheimnis ab —
 * dem Weg, der den Wegfall des Ed25519-Anmeldeschluessels ueberlebt
 * (Spec §3b, s. `pickelUebergangPlan.ts`).
 *
 * **Warum ein `CryptoKey` und nicht 32 rohe Bytes im Speicher:** das Geheimnis
 * wird als `extractable: false` erzeugt (`geraeteGeheimnis.ts`). JavaScript
 * kann damit ableiten, es aber nicht auslesen — dieselbe Eigenschaft, die
 * heute der Anmeldeschluessel mitbringt und auf die sich der Kopf von
 * `account.svelte.ts` beruft. Rohe Bytes waeren beim ersten Auskippen der
 * IndexedDB mit weg.
 *
 * HMAC-SHA-256 liefert 32 Bytes, genau die Laenge, die `Identitaet.einfrieren`
 * erwartet — kein Zuschneiden noetig.
 */
export async function pickelschluesselAusGeheimnis(geheimnis: CryptoKey): Promise<Uint8Array> {
  const kontext = new TextEncoder().encode(PICKLE_KONTEXT_V2);
  const roh = await crypto.subtle.sign('HMAC', geheimnis, kontext);
  return new Uint8Array(roh);
}
