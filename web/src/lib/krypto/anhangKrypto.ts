/**
 * Die Nutzdaten-Verschluesselung fuer Anhaenge — die ERSTE im Klienten
 * ueberhaupt (bis hierher gab es nur Signaturen in `identity/keypair.svelte.ts`
 * und Hashing in `krypto/pickelschluessel.ts`; die Nachrichten selbst
 * verschluesselt der Rust-Kern, nicht WebCrypto).
 *
 * ## Die Wahl, und warum
 *
 * **AES-256-GCM ueber WebCrypto.** Kein Eigenbau und keine neue
 * Abhaengigkeit: `crypto.subtle` ist in jedem Browser eingebaut, den Pulse
 * bedient, und in Node (fuer `pnpm test:unit`) ebenfalls. GCM statt CTR/CBC,
 * weil es die Bytes zugleich beglaubigt — ein Klumpen, an dem jemand
 * herumgeschraubt hat, faellt beim Entschluesseln als Fehler an, statt als
 * stiller Bildmuell durchzugehen. Der Objektspeicher ist die einzige Stelle
 * dieses Weges, an der ein Fremder ueberhaupt Bytes veraendern koennte, und
 * genau dagegen ist das Siegel da.
 *
 * **Ein eigener Schluessel je Klumpen — Datei UND Vorschaubild jeweils
 * einer.** Das ist die Antwort auf die einzige scharfe Bedingung von GCM:
 * derselbe (Schluessel, IV) darf sich NIE wiederholen, sonst faellt die
 * Beglaubigung in sich zusammen. Mit einem Schluessel je Klumpen ist die
 * Bedingung nicht bloss unwahrscheinlich verletzt, sondern strukturell
 * unerreichbar: `verschluessele` wird je erzeugtem Schluessel genau einmal
 * gerufen (`attachments/uploadVerschluesselt.ts` erzeugt fuer Datei und
 * Vorschaubild getrennt einen und laedt jeden Klumpen genau einmal hoch), es
 * gibt also gar keine zwei IVs unter einem Schluessel, die kollidieren
 * koennten. Der Preis sind 32 zusaetzliche Bytes in der verschluesselten
 * Nachricht — der Gegenwert ist eine Zusicherung, die man nachrechnen kann,
 * statt einer Wahrscheinlichkeitsaussage.
 *
 * Die naheliegende Alternative — ein Schluessel, zwei verschiedene IVs — ist
 * nicht falsch, aber ihre Sicherheit haengt daran, dass jede kuenftige
 * Aufrufstelle diszipliniert bleibt. Diese hier haengt an nichts.
 *
 * **Der IV ist trotzdem zufaellig und steht vorne im Klumpen.** Er koennte
 * bei einmaliger Verwendung auch fest sein; zufaellig gewaehlt bleibt die
 * Zusicherung aber auch dann noch erhalten, wenn jemand spaeter doch einen
 * Schluessel zweimal verwendet — dann ist sie nur noch statistisch (96 Bit),
 * statt gebrochen. 12 Bytes, weil GCM fuer genau diese Laenge ohne
 * Zwischenschritt arbeitet.
 *
 * Format eines Klumpens: `IV (12 Bytes) || Geheimtext+Siegel`.
 *
 * Importfrei, damit Nodes eingebauter Testlaeufer die Datei ohne Bundler
 * prueft (s. CLAUDE.md „Die Falle") — `crypto`, `btoa` und `atob` sind in
 * Browser wie Node global.
 */

/** GCMs Standard-IV-Laenge. Andere Laengen sind erlaubt, brauchen intern aber
 *  eine zusaetzliche Ableitung — 12 Bytes ist der direkte Weg. */
export const IV_LAENGE = 12;

/** 256 Bit. AES-128 taete es auch; der Unterschied kostet hier nichts. */
const SCHLUESSEL_BYTES = 32;

/** Ein frischer Dateischluessel. Roh (nicht als `CryptoKey`), weil er als
 *  Text in die verschluesselte Nachricht wandert. */
export function neuerDateischluessel(): Uint8Array {
  const roh = new Uint8Array(SCHLUESSEL_BYTES);
  crypto.getRandomValues(roh);
  return roh;
}

async function importiere(roh: Uint8Array, zweck: 'encrypt' | 'decrypt'): Promise<CryptoKey> {
  if (roh.length !== SCHLUESSEL_BYTES) {
    throw new Error(`Dateischluessel muss ${SCHLUESSEL_BYTES} Bytes haben, hat ${roh.length}`);
  }
  return crypto.subtle.importKey('raw', roh as unknown as BufferSource, 'AES-GCM', false, [zweck]);
}

/**
 * Verschluesselt einen Klumpen. **Je Schluessel genau EINMAL aufrufen** — die
 * Wiederholungsfreiheit des IV haengt daran (s. Modulkopf).
 */
export async function verschluessele(
  schluesselRoh: Uint8Array,
  klartext: Uint8Array
): Promise<Uint8Array> {
  const iv = new Uint8Array(IV_LAENGE);
  crypto.getRandomValues(iv);
  const schluessel = await importiere(schluesselRoh, 'encrypt');
  const geheim = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: iv as unknown as BufferSource },
      schluessel,
      klartext as unknown as BufferSource
    )
  );
  const klumpen = new Uint8Array(iv.length + geheim.length);
  klumpen.set(iv, 0);
  klumpen.set(geheim, iv.length);
  return klumpen;
}

/** Kehrt `verschluessele` um. Wirft, wenn das Siegel nicht passt — ein
 *  veraenderter oder mit dem falschen Schluessel geoeffneter Klumpen kommt
 *  NIE als Bytes zurueck. */
export async function entschluessele(
  schluesselRoh: Uint8Array,
  klumpen: Uint8Array
): Promise<Uint8Array> {
  if (klumpen.length <= IV_LAENGE) {
    throw new Error('Klumpen zu kurz — kein IV enthalten');
  }
  const iv = klumpen.subarray(0, IV_LAENGE);
  const geheim = klumpen.subarray(IV_LAENGE);
  const schluessel = await importiere(schluesselRoh, 'decrypt');
  return new Uint8Array(
    await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: iv as unknown as BufferSource },
      schluessel,
      geheim as unknown as BufferSource
    )
  );
}

/** Base64 MIT Polsterung — anders als der Rust-Kern (s. CLAUDE.md), weil
 *  dieser Wert nie einen Python-Dekodierer erreicht: er faehrt im
 *  VERSCHLUESSELTEN Nutzlast-JSON mit und wird nur vom Klienten gelesen. */
export function schluesselAlsText(roh: Uint8Array): string {
  let s = '';
  for (const byte of roh) s += String.fromCharCode(byte);
  return btoa(s);
}

/** Kehrt `schluesselAlsText` um. Wirft bei einer Laenge, die kein
 *  AES-256-Schluessel sein kann — fail-closed, statt spaeter beim Importieren
 *  einen unverstaendlicheren Fehler zu erzeugen. */
export function schluesselAusText(text: string): Uint8Array {
  const roh = atob(text);
  if (roh.length !== SCHLUESSEL_BYTES) {
    throw new Error(`Dateischluessel muss ${SCHLUESSEL_BYTES} Bytes haben, hat ${roh.length}`);
  }
  const bytes = new Uint8Array(roh.length);
  for (let i = 0; i < roh.length; i++) bytes[i] = roh.charCodeAt(i);
  return bytes;
}
