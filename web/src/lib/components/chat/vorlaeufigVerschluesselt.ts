/**
 * Die Uhr der Häkchen-Treppe für verschlüsselte Sendungen (DM und Gruppe).
 *
 * Bis 2026-10-10 erschien eine verschlüsselte Nachricht erst, wenn die ganze
 * Sendung durch war (Schlüssel holen, verschlüsseln, einliefern, ablegen) —
 * das Eingabefeld war da schon leer, und dazwischen stand nichts. Die Uhr gab
 * es nur im längst stillgelegten Klartext-Weg.
 *
 * Jetzt steht sofort eine vorläufige Kopie unter einer `tmp-`-ID da (die
 * Anzeige macht daraus die Uhr und sperrt Bearbeiten/Löschen/Reagieren, s.
 * `MessageItem.svelte`). Die echte Nachricht ersetzt sie an derselben Stelle
 * über die gemeinsame `nonce` (`messages.upsert`); scheitert die Sendung,
 * verschwindet sie wieder — die Fehlermeldung kommt vom Sendeweg selbst.
 * Die Kopie landet nie im lokalen Verlauf, nur in der Anzeige.
 */
import type { Message } from '$lib/api/types';
import type { AnhangAngabe } from '$lib/krypto/nachrichtNutzlast';
import { anhangAngabeZuAttachment } from '$lib/krypto/anhangAnzeige';
import { messages } from '$lib/stores/messages.svelte';
import { parseMentionMarkers } from '$lib/components/mentionMarkierungen';

export interface Vorlaeufig {
  nonce: string;
  /** Die echte Nachricht übernehmen — ersetzt die Kopie an ihrer Stelle. */
  ersetzen(echt: Message): void;
  /** Kopie entfernen; harmlos, wenn sie schon ersetzt wurde. */
  entfernen(): void;
}

export function vorlaeufigZeigen(
  kanalId: string,
  autorId: string,
  text: string,
  replyToId: string | null,
  anhaenge: AnhangAngabe[]
): Vorlaeufig {
  const nonce = `n-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`;
  const tmpId = `tmp-${nonce}`;
  messages.addOptimistic({
    id: tmpId,
    channel_id: kanalId,
    author_id: autorId,
    content: text,
    nonce,
    reply_to_id: replyToId,
    created_at: new Date().toISOString(),
    mentions: parseMentionMarkers(text),
    verschluesselt: true,
    ...(anhaenge.length > 0 ? { attachments: anhaenge.map(anhangAngabeZuAttachment) } : {})
  });
  return {
    nonce,
    ersetzen: (echt) => messages.upsert({ ...echt, nonce }),
    entfernen: () => messages.remove(kanalId, tmpId)
  };
}
