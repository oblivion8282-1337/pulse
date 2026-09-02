/**
 * Die verschlüsselte Dateiablage — Dateien auf dem Cloud-Laufwerk des
 * Erstellers, clientseitig verschlüsselt (Konzept „Kanäle mit eigener
 * Ablage", Dateiablage-Teil).
 *
 * Format je Datei (`.puls`-Container):
 *
 *   "PADF" (4) | Fassung (1) | KopfLen (4, big endian)
 *   | IV (12) | Kopf (JSON, AES-256-GCM mit dem Ablage-Hauptschlüssel)
 *   | IV (12) | Inhalt (AES-256-GCM mit einem Zufalls-Inhaltsschlüssel)
 *
 * Zwei Schlüssel, zwei Zwecke: der **Inhaltsschlüssel** (zufällig je Datei)
 * verschlüsselt die Bytes; der **Ablage-Hauptschlüssel** (zufällig je
 * Ablage-Ordner, nur auf den Geräten der Berechtigten) schützt Kopf und
 * Verzeichnis. Der Kopf trägt den Klartext-Dateinamen und den MIME-Typ —
 * genau die Metadaten, die der Server NIEMALS sehen darf. Der
 * Inhaltsschlüssel steckt nicht im Kopf, sondern im Verzeichnis — damit
 * Verzeichnis-Verlust nicht gleich Inhalts-Verlust heißt, ist er dort
 * only-once verzeichnet und das Verzeichnis selbst ist wiederherstellbar
 * (Kopf trägt alles außer dem Inhaltsschlüssel — Inhalt bleibt dann zwar
 * verschlüsselt, aber die Dateiliste lässt sich neu aufbauen).
 *
 * Rein rechnerisch und import-frei — Node-Testläufer-regel.
 */

export const DATEI_KENNUNG = 0x50414446; // "PADF"
export const DATEI_FASSUNG = 1;

const IV_LAENGE = 12;

export class DateiablageFehler extends Error {
  constructor(meldung: string) {
    super(meldung);
    this.name = 'DateiablageFehler';
  }
}

export interface DateiKopf {
  fassung: number;
  name: string;
  mime: string;
  groesse: number;
  hochgeladenAm: string;
  hochgeladenVon: string;
}

function zufallsBytes(laenge: number): Uint8Array {
  const bytes = new Uint8Array(laenge);
  globalThis.crypto.getRandomValues(bytes);
  return bytes;
}

/** Eigenständige Kopie — WebCrypto braucht echte ArrayBuffer, keine Views. */
function eigen(bytes: Uint8Array): Uint8Array {
  return bytes.slice();
}

async function gcmVerschlüsseln(
  schlüssel: Uint8Array,
  iv: Uint8Array,
  klar: Uint8Array,
  zusatz: Uint8Array,
): Promise<Uint8Array> {
  const krypto = globalThis.crypto.subtle;
  const ref = await krypto.importKey(
    'raw',
    schlüssel as unknown as ArrayBuffer,
    { name: 'AES-GCM' },
    false,
    ['encrypt'],
  );
  return new Uint8Array(
    await krypto.encrypt({ name: 'AES-GCM', iv: eigen(iv) as unknown as ArrayBuffer, additionalData: eigen(zusatz) as unknown as ArrayBuffer }, ref, eigen(klar) as unknown as ArrayBuffer),
  );
}

async function gcmEntschlüsseln(
  schlüssel: Uint8Array,
  iv: Uint8Array,
  dunkel: Uint8Array,
  zusatz: Uint8Array,
): Promise<Uint8Array> {
  const krypto = globalThis.crypto.subtle;
  const ref = await krypto.importKey(
    'raw',
    schlüssel as unknown as ArrayBuffer,
    { name: 'AES-GCM' },
    false,
    ['decrypt'],
  );
  return new Uint8Array(
    await krypto.decrypt({ name: 'AES-GCM', iv: eigen(iv) as unknown as ArrayBuffer, additionalData: eigen(zusatz) as unknown as ArrayBuffer }, ref, eigen(dunkel) as unknown as ArrayBuffer),
  );
}

/** Packt eine Datei in den verschlüsselten Container. */
export async function packeDateiContainer(
  hauptschlüssel: Uint8Array,
  kopf: Omit<DateiKopf, 'fassung'>,
  inhalt: Uint8Array,
): Promise<Uint8Array> {
  const kopfJson = new TextEncoder().encode(
    JSON.stringify({ fassung: DATEI_FASSUNG, ...kopf, groesse: inhalt.length }),
  );
  const ivKopf = zufallsBytes(IV_LAENGE);
  const verschlüsselungsschlüssel = await sha256(hauptschlüssel, 'ablage-kopf');
  const kopfDunkel = await gcmVerschlüsseln(
    verschlüsselungsschlüssel,
    ivKopf,
    kopfJson,
    new Uint8Array(0),
  );

  const ivInhalt = zufallsBytes(IV_LAENGE);
  const inhaltSchlüssel = zufallsBytes(32);
  const inhaltDunkel = await gcmVerschlüsseln(
    inhaltSchlüssel,
    ivInhalt,
    inhalt,
    new Uint8Array(0),
  );
  const inhaltSchlüsselVerschlüsselt = await gcmVerschlüsseln(
    verschlüsselungsschlüssel,
    ivKopf,
    inhaltSchlüssel,
    new TextEncoder().encode('inhaltsschlüssel'),
  );

  const kopfDunkelGesamt = new Uint8Array(
    ivKopf.length + inhaltSchlüsselVerschlüsselt.length + kopfDunkel.length,
  );
  kopfDunkelGesamt.set(ivKopf, 0);
  kopfDunkelGesamt.set(inhaltSchlüsselVerschlüsselt, ivKopf.length);
  kopfDunkelGesamt.set(kopfDunkel, ivKopf.length + inhaltSchlüsselVerschlüsselt.length);

  const gesamt = new Uint8Array(4 + 1 + 4 + kopfDunkelGesamt.length + IV_LAENGE + inhaltDunkel.length);
  const sicht = new DataView(gesamt.buffer);
  sicht.setUint32(0, DATEI_KENNUNG);
  sicht.setUint8(4, DATEI_FASSUNG);
  sicht.setUint32(5, kopfDunkelGesamt.length);
  gesamt.set(kopfDunkelGesamt, 9);
  gesamt.set(ivInhalt, 9 + kopfDunkelGesamt.length);
  gesamt.set(inhaltDunkel, 9 + kopfDunkelGesamt.length + IV_LAENGE);
  return gesamt;
}

export interface GeöffneteDatei {
  kopf: DateiKopf;
  inhalt: Uint8Array;
}

/** Öffnet einen Container — wirft bei Manipulation oder falschem Schlüssel. */
export async function öffneDateiContainer(
  hauptschlüssel: Uint8Array,
  container: Uint8Array,
): Promise<GeöffneteDatei> {
  if (container.length < 9) {
    throw new DateiablageFehler('Container zu kurz');
  }
  const sicht = new DataView(container.buffer, container.byteOffset, container.byteLength);
  if (sicht.getUint32(0) !== DATEI_KENNUNG) {
    throw new DateiablageFehler('falsche Kennung');
  }
  if (sicht.getUint8(4) !== DATEI_FASSUNG) {
    throw new DateiablageFehler(`unbekannte Fassung: ${sicht.getUint8(4)}`);
  }
  const kopfDunkelGesamtLaenge = sicht.getUint32(5);
  if (9 + kopfDunkelGesamtLaenge > container.length) {
    throw new DateiablageFehler('Kopf reicht über das Dateiende');
  }

  const verschlüsselungsschlüssel = await sha256(hauptschlüssel, 'ablage-kopf');
  const ivKopf = container.slice(9, 9 + IV_LAENGE);
  const inhaltSchlüsselDunkel = container.slice(
    9 + IV_LAENGE,
    9 + IV_LAENGE + 48,
  );
  const kopfDunkel = container.slice(9 + IV_LAENGE + 48, 9 + kopfDunkelGesamtLaenge);
  const kopfJson = await gcmEntschlüsseln(
    verschlüsselungsschlüssel,
    ivKopf,
    kopfDunkel,
    new Uint8Array(0),
  );
  const kopf = JSON.parse(new TextDecoder().decode(kopfJson)) as DateiKopf;

  const ivInhalt = container.slice(9 + kopfDunkelGesamtLaenge, 9 + kopfDunkelGesamtLaenge + IV_LAENGE);
  const inhaltDunkel = container.slice(9 + kopfDunkelGesamtLaenge + IV_LAENGE);
  const inhaltSchlüssel = await gcmEntschlüsseln(
    verschlüsselungsschlüssel,
    ivKopf,
    inhaltSchlüsselDunkel,
    new TextEncoder().encode('inhaltsschlüssel'),
  );
  const inhalt = await gcmEntschlüsseln(inhaltSchlüssel, ivInhalt, inhaltDunkel, new Uint8Array(0));
  return { kopf, inhalt };
}

async function sha256(bytes: Uint8Array, kontext: string): Promise<Uint8Array> {
  const krypto = globalThis.crypto.subtle;
  const eingabe = new Uint8Array(bytes.length + kontext.length);
  eingabe.set(bytes, 0);
  eingabe.set(new TextEncoder().encode(kontext), bytes.length);
  return new Uint8Array(await krypto.digest('SHA-256', eigen(eingabe) as unknown as ArrayBuffer));
}

// ---------------------------------------------------------------------------
// Verzeichnis: der verschlüsselte Index der Ablage
// ---------------------------------------------------------------------------

export interface AblageEintrag {
  id: string;
  datei: string;
  name: string;
  mime: string;
  groesse: number;
  hochgeladenAm: string;
  hochgeladenVon: string;
}

export interface VerzeichnisDaten {
  fassung: number;
  einträge: AblageEintrag[];
}

export class VerzeichnisFehler extends Error {
  constructor(meldung: string) {
    super(meldung);
    this.name = 'VerzeichnisFehler';
  }
}

export function leeresVerzeichnis(): VerzeichnisDaten {
  return { fassung: 1, einträge: [] };
}

export async function verschlüsseleVerzeichnis(
  hauptschlüssel: Uint8Array,
  verzeichnis: VerzeichnisDaten,
): Promise<Uint8Array> {
  const iv = zufallsBytes(IV_LAENGE);
  const json = new TextEncoder().encode(JSON.stringify(verzeichnis));
  const dunkel = await gcmVerschlüsseln(hauptschlüssel, iv, json, new Uint8Array(0));
  const gesamt = new Uint8Array(4 + 1 + IV_LAENGE + dunkel.length);
  const sicht = new DataView(gesamt.buffer);
  sicht.setUint32(0, 0x50555656); // "PUVV"
  sicht.setUint8(4, 1);
  gesamt.set(iv, 5);
  gesamt.set(dunkel, 17);
  return gesamt;
}

export async function öffneVerzeichnis(
  hauptschlüssel: Uint8Array,
  bytes: Uint8Array,
): Promise<VerzeichnisDaten> {
  if (bytes.length < 17) {
    throw new VerzeichnisFehler('Verzeichnis zu kurz');
  }
  const iv = bytes.slice(5, 17);
  const dunkel = bytes.slice(17);
  let json: Uint8Array;
  try {
    json = await gcmEntschlüsseln(hauptschlüssel, iv, dunkel, new Uint8Array(0));
  } catch {
    throw new VerzeichnisFehler('Entschlüsselung fehlgeschlagen — falscher Schlüssel oder beschädigte Daten');
  }
  const daten = JSON.parse(new TextDecoder().decode(json)) as VerzeichnisDaten;
  if (daten.fassung !== 1 || !Array.isArray(daten.einträge)) {
    throw new VerzeichnisFehler('unlesbares Verzeichnis');
  }
  return daten;
}
