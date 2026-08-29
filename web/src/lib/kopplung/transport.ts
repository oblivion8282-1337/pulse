/**
 * Was der Server beim Umzug NICHT erfaehrt (Etappe F, E2E-DM).
 *
 * Zwei Ableitungen aus demselben Kopplungscode, und ihr Unterschied ist der
 * ganze Trick:
 *
 * * `codeHash` — geht an den Server. Er sucht damit die Kopplung.
 * * `transportSchluessel` — bleibt hier. Damit werden die Stuecke gesiegelt.
 *
 * Weil der Code selbst diese Leitung nie ueberquert (er reist ueber den
 * Bildschirm), kann der Server aus dem, was er hat, den Schluessel nicht
 * bilden. **Das ist der Grund, warum der Umzug nicht ueber Olm laufen muss**
 * und trotzdem Ende-zu-Ende-verschluesselt ist — s. den Kopf von
 * `routes/kopplung_umzug.py` fuer die drei Gruende, warum Olm hier nicht
 * traegt.
 *
 * **Domaenentrennung ist Pflicht, nicht Zierde.** Haette der Hash denselben
 * Vorspann wie die Schluesselableitung, waere der an den Server gegebene Wert
 * eine Funktion desselben Eingangs auf demselben Weg. Getrennte Kontexte
 * (`pulse-kopplung-v1` gegen `pulse-umzug-v1`) machen die beiden Ausgaenge
 * unabhaengig — aus dem einen folgt der andere nicht.
 *
 * **HKDF statt schlichtem SHA-256 fuer den Schluessel**, obwohl der Eingang
 * schon gleichverteilt ist (20 Zeichen aus `crypto.getRandomValues`): HKDF
 * bindet `info` mit ein, und dort steht die Kopplungs-ID. Zwei Umzuege
 * desselben Kontos bekommen so verschiedene Schluessel, auch wenn jemand
 * denselben Code zweimal erzeugte.
 *
 * Importfrei — `crypto` und `TextEncoder` sind in Browser und Node global.
 * Die Base64-Helfer stehen deshalb hier noch einmal statt aus
 * `utils/base64url.ts` zu kommen (dessen Import wuerde die Node-Pruefbarkeit
 * dieser Datei kosten, s. CLAUDE.md „Die Falle").
 */

const ENC = new TextEncoder();

/** Trennt den Server-Hash von jeder anderen Ableitung aus demselben Code. */
const HASH_KONTEXT = 'pulse-kopplung-v1';
/** Trennt die Schluesselableitung vom Server-Hash. */
const SCHLUESSEL_SALZ = 'pulse-umzug-v1';
/** Trennt die Inhalts-Kennung vom Transportschluessel — eigener HKDF-Kontext,
 *  s. `stueckKennungSchluessel`. */
const KENNUNG_SALZ = 'pulse-umzug-kennung-v1';
/** GCMs Standard-IV-Laenge, wie in `krypto/anhangKrypto.ts`. */
const IV_LAENGE = 12;

function base64UrlAus(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Base64 MIT Polsterung — Python liest diesen Wert (`_stueck_groesse` haengt
 *  ohnehin `"=="` an, aber der Server soll nichts flicken muessen, was der
 *  Klient richtig schreiben kann). */
export function base64Aus(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

/** Kehrt `base64Aus` um; toleriert fehlende Polsterung. */
export function base64Zu(text: string): Uint8Array {
  const pad = '='.repeat((4 - (text.length % 4)) % 4);
  const bin = atob(text + pad);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/**
 * Der Wert, den der Server als Suchschluessel bekommt.
 *
 * Muss byte-genau zu `test_kopplung.py::_code_hash` passen — das Nullbyte
 * zwischen Kontext und Code ist Teil der Vorschrift, nicht Kosmetik (dasselbe
 * Trennzeichen und derselbe Grund wie in `schluessel_nachweis.baue_nutzlast`:
 * es kommt in keinem Alphabet vor, das hier auftaucht).
 */
export async function codeHash(code: string): Promise<string> {
  const eingang = ENC.encode(HASH_KONTEXT + '\u0000' + code);
  const roh = await crypto.subtle.digest('SHA-256', eingang as unknown as BufferSource);
  return base64UrlAus(new Uint8Array(roh));
}

/** Leitet den AES-256-GCM-Schluessel dieses einen Umzugs ab. */
export async function transportSchluessel(code: string, kopplungId: string): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    'raw',
    ENC.encode(code) as unknown as BufferSource,
    'HKDF',
    false,
    ['deriveKey']
  );
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: ENC.encode(SCHLUESSEL_SALZ) as unknown as BufferSource,
      info: ENC.encode(kopplungId) as unknown as BufferSource
    },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

/**
 * Schluessel fuer die Inhalts-Kennung eines Stuecks — eigener HKDF-Kontext,
 * getrennt vom Transportschluessel (Domaenentrennung ist Pflicht, nicht
 * Zierde, s. Modulkopf).
 */
export async function stueckKennungSchluessel(code: string, kopplungId: string): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    'raw',
    ENC.encode(code) as unknown as BufferSource,
    'HKDF',
    false,
    ['deriveKey']
  );
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: ENC.encode(KENNUNG_SALZ) as unknown as BufferSource,
      info: ENC.encode(kopplungId) as unknown as BufferSource
    },
    material,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
}

/**
 * Die Inhalts-Kennung eines Stuecks — ein HMAC ueber Position und Klartext.
 *
 * **Wozu, wenn `daten` schon verschluesselt beim Server liegt:** der
 * zufaellige IV macht jede Verschluesselung desselben Klartexts anders —
 * der Chiffretext taugt also nicht zum Wiedererkennen „ist das noch derselbe
 * Inhalt". Diese Kennung ist deterministisch (kein IV) und dient NUR dem
 * SENDER als spaeteren Abgleich beim Fortsetzen (`senden.ts`): stimmt sie
 * nicht mehr mit dem lokal neu berechneten Wert ueberein, ist das Stueck
 * veraltet und wird neu geschoben, statt still uebernommen zu werden.
 *
 * Der Server sieht darin nichts ausser einem undurchsichtigen HMAC — ableiten
 * kann ihn nur, wer den Kopplungscode kennt, und der erreicht den Server nie
 * (s. Modulkopf). Die Position geht mit ein, aus demselben Grund wie bei
 * `zusatzdaten`: zwei inhaltsgleiche Stuecke an verschiedenen Positionen
 * ergeben verschiedene Kennungen.
 */
export async function stueckKennung(
  schluessel: CryptoKey,
  folge: number,
  klartext: Uint8Array
): Promise<string> {
  const praefix = ENC.encode(`${folge}:`);
  const eingang = new Uint8Array(praefix.length + klartext.length);
  eingang.set(praefix, 0);
  eingang.set(klartext, praefix.length);
  const signatur = await crypto.subtle.sign('HMAC', schluessel, eingang as unknown as BufferSource);
  return base64UrlAus(new Uint8Array(signatur));
}

/**
 * Die Position geht als zusaetzliche authentifizierte Daten mit.
 *
 * Damit ist ein Stueck an SEINE Stelle in SEINEM Umzug gebunden: ein vom
 * Server vertauschtes oder aus einem anderen Umzug untergeschobenes Stueck
 * scheitert beim Entschluesseln, statt still an falscher Stelle zu landen.
 * Ohne diese Bindung waere der Chiffretext zwar weiter unlesbar, die
 * REIHENFOLGE des Verlaufs aber fremdbestimmt.
 */
function zusatzdaten(kopplungId: string, folge: number): Uint8Array {
  return ENC.encode(`${kopplungId}:${folge}`);
}

/** Verschluesselt ein Stueck. Format: `IV (12 Bytes) || Geheimtext+Siegel`. */
export async function stueckVerschluesseln(
  schluessel: CryptoKey,
  kopplungId: string,
  folge: number,
  klartext: Uint8Array
): Promise<string> {
  const iv = new Uint8Array(IV_LAENGE);
  crypto.getRandomValues(iv);
  const geheim = new Uint8Array(
    await crypto.subtle.encrypt(
      {
        name: 'AES-GCM',
        iv: iv as unknown as BufferSource,
        additionalData: zusatzdaten(kopplungId, folge) as unknown as BufferSource
      },
      schluessel,
      klartext as unknown as BufferSource
    )
  );
  const klumpen = new Uint8Array(iv.length + geheim.length);
  klumpen.set(iv, 0);
  klumpen.set(geheim, iv.length);
  return base64Aus(klumpen);
}

/** Kehrt `stueckVerschluesseln` um. Wirft, wenn Siegel, Schluessel oder
 *  Position nicht passen — ein veraendertes Stueck kommt NIE als Bytes
 *  zurueck. */
export async function stueckEntschluesseln(
  schluessel: CryptoKey,
  kopplungId: string,
  folge: number,
  daten: string
): Promise<Uint8Array> {
  const klumpen = base64Zu(daten);
  if (klumpen.length <= IV_LAENGE) throw new Error('Stueck zu kurz — kein IV enthalten');
  return new Uint8Array(
    await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: klumpen.subarray(0, IV_LAENGE) as unknown as BufferSource,
        additionalData: zusatzdaten(kopplungId, folge) as unknown as BufferSource
      },
      schluessel,
      klumpen.subarray(IV_LAENGE) as unknown as BufferSource
    )
  );
}
