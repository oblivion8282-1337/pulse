/**
 * Baut die anzuzeigende `Message` aus einer geoeffneten Postfach-Zustellung —
 * gemeinsam fuer BEIDE Entschluesselungswege: den Olm-Weg
 * (`zustellungOeffnen.ts`, DMs) und den Megolm-Weg (`gruppe/empfangen.ts`,
 * private Gruppen und Ablage-Kanaele).
 *
 * Vorher stand dieses Objekt in beiden Dateien, Feld fuer Feld gleich — aber
 * die Begruendungen der drei nicht offensichtlichen Stellen (ID-Wahl, die
 * beiden bedingten Spreads) nur in EINER von beiden. Genau so verliert eine
 * Kopie ihre Traeger: wer in `gruppe/empfangen.ts` las, sah das `...(… ? … :
 * {})` ohne den Grund dafuer. Hier steht beides einmal.
 */
import type { Message } from '../api/types';
import type { PostfachZustellung } from '../api/postfach';
import type { NachrichtNutzlast } from './nachrichtNutzlast';
import { anhangAngabeZuAttachment } from './anhangAnzeige';
import { parseMentionMarkers } from '../components/mentionMarkierungen';

export function baueEmpfangeneNachricht(
  z: PostfachZustellung,
  autorId: string,
  gelesen: NachrichtNutzlast
): Message {
  const { text, id: kanonischeId, replyToId, anhaenge } = gelesen;
  return {
    // Snowflake der Zustellung: digit-only wie ein echter Server-Snowflake,
    // sortiert also im lokalen Verlauf korrekt nach Zeit. BEWUSST NICHT die
    // kanonische Autor-ID — sie bleibt fuer Quittierung/Schon-abgelegt-
    // Pruefung an die Zustellung gebunden (`postfachZyklus`/
    // `verlaufSchonAbgelegt`).
    id: z.id,
    channel_id: z.channel_id,
    author_id: autorId,
    content: text,
    nonce: null,
    reply_to_id: replyToId,
    created_at: new Date().toISOString(),
    // Lokal geparst, s. `mentionMarkierungen.ts`-Modulkopf.
    mentions: parseMentionMarkers(text),
    // Erkennungsmerkmal, s. `Message.verschluesselt` in `api/types.ts`.
    verschluesselt: true,
    // Kanonische Autor-ID, falls die Nutzlast sie trug (s. `Message.krypto_id`
    // in `api/types.ts`) — noetig, damit eine spaetere Antwort AUF DIESE
    // Nachricht sie wiederfindet. Nur setzen, wenn vorhanden: ein
    // ausdrueckliches `krypto_id: undefined` waere ein anderes Objekt als
    // keines.
    ...(kanonischeId !== null ? { krypto_id: kanonischeId } : {}),
    // Anhang-Angaben (Etappe E) — Schluessel, Name, Typ, Maße. Die BYTES holt
    // `anhaengeHolen` (`empfangen.ts`), VOR der Quittung.
    ...(anhaenge.length > 0 ? { attachments: anhaenge.map(anhangAngabeZuAttachment) } : {})
  };
}
