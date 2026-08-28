/**
 * Nutzlast einer einzelnen Ende-zu-Ende-verschluesselten Direktnachricht —
 * das, was NACH dem Entschluesseln als Klartext-Bytes vorliegt (nicht zu
 * verwechseln mit `nutzlast.ts`, das die Ed25519-Nachweis-Bytes fuer die
 * Signatur baut — andere Bedeutung von "Nutzlast", andere Datei).
 *
 * FASSUNG 1: JSON `{v:1, text: string, id?: string, replyToId?: string}`.
 *
 * `id` ist die vom AUTOR gewaehlte, geraeteuebergreifende Nachrichten-ID
 * (`senden.ts::lokaleNachrichtId()`). Sie MUSS mitgeschickt werden, weil die
 * lokale `Message.id` auf dem Absender- und dem Empfaenger-Geraet
 * verschieden ist (Absender: selbst gewaehlt; Empfaenger: die
 * Postfach-Zustellungs-Kennung, s. `empfangen.ts`-Modulkopf) — ohne eine
 * geteilte Kennung koennte KEINE Gegenseite eine spaetere Antwort auf diese
 * Nachricht wiederfinden. `replyToId` traegt deshalb ebenfalls immer die
 * KANONISCHE Form (`kanonischeAntwortId.ts` uebersetzt dahin, bevor gesendet
 * wird), nie eine rein lokale ID.
 *
 * Beide Felder sind beim LESEN optional, damit eine Nutzlast, die sie nicht
 * kennt, trotzdem vollstaendig gelesen wird — ein zusaetzliches Feld haelt
 * niemanden vom ENTSCHLUESSELN ab (Olm entschluesselt beliebige Bytes,
 * unabhaengig von deren Struktur), die Fassung betrifft nur, wie die bereits
 * entschluesselten Bytes GELESEN werden. `leseNachrichtNutzlast` erkennt
 * zusaetzlich den Legacy-Fall: ein SENDER von vor dieser Aenderung hat den
 * Klartext ganz ohne Huelle verschickt (roher Text, kein JSON) — misslingt
 * das Parsen als Fassung-1-Objekt, gilt der komplette entschluesselte Text
 * als Nachrichtentext ohne Kennung und ohne Antwortbezug.
 *
 * Importfrei, damit Nodes eingebauter Testlaeufer die Datei ohne Bundler
 * prueft (s. CLAUDE.md „Die Falle").
 */

const FASSUNG = 1;

export type NachrichtNutzlast = {
  text: string;
  /** Kanonische Nachrichten-ID des Autors — `null` nur bei einer Legacy-
   *  Nutzlast ohne dieses Feld. */
  id: string | null;
  replyToId: string | null;
};

/** Baut die Klartext-Bytes, die die Sitzung anschliessend verschluesselt.
 *  `nachrichtId` ist IMMER die kanonische Autor-ID dieser Nachricht (s.
 *  Modulkopf); `replyToId` (falls gesetzt) MUSS bereits die kanonische Form
 *  des Ziels sein (`kanonischeAntwortId.ts`), keine lokale ID. */
export function baueNachrichtNutzlast(
  text: string,
  nachrichtId: string,
  replyToId: string | null
): Uint8Array {
  const objekt: Record<string, unknown> = { v: FASSUNG, text, id: nachrichtId };
  if (replyToId !== null) objekt.replyToId = replyToId;
  return new TextEncoder().encode(JSON.stringify(objekt));
}

/** Liest die entschluesselten Klartext-Bytes einer Zustellung zurueck. */
export function leseNachrichtNutzlast(bytes: Uint8Array): NachrichtNutzlast {
  const roh = new TextDecoder().decode(bytes);
  try {
    const geparst: unknown = JSON.parse(roh);
    if (
      geparst !== null &&
      typeof geparst === 'object' &&
      (geparst as Record<string, unknown>).v === FASSUNG &&
      typeof (geparst as Record<string, unknown>).text === 'string'
    ) {
      const o = geparst as Record<string, unknown>;
      return {
        text: o.text as string,
        id: typeof o.id === 'string' ? o.id : null,
        replyToId: typeof o.replyToId === 'string' ? o.replyToId : null
      };
    }
  } catch {
    // Kein JSON, oder nicht Fassung 1 -> Legacy-Klartext, s. Modulkopf.
  }
  return { text: roh, id: null, replyToId: null };
}
