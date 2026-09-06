/**
 * Findet die Nachricht, auf die `replyToId` zeigt.
 *
 * Zwei Vergleiche, weil `reply_to_id` bei einer verschluesselten Antwort die
 * KANONISCHE Autor-ID des Ziels traegt (`krypto/kanonischeAntwortId.ts`),
 * eine EMPFANGENE verschluesselte Nachricht aber lokal unter einer ANDEREN
 * `id` liegt (Postfach-Zustellungs-Kennung, s. `krypto/empfangen.ts`) —
 * ihre kanonische Form steht dann zusaetzlich in `krypto_id`
 * (`api/types.ts`). Fuer eine Klartext-Nachricht oder eine eigene gesendete
 * verschluesselte Nachricht ist `id` schon die kanonische Form, der erste
 * Vergleich reicht dort.
 *
 * Ausgelagert aus `MessageList.svelte` (Groessen-Policy, `CLAUDE.md` §
 * Code-Groesse) — importiert `Message`, deshalb kein Kandidat fuer Nodes
 * importfreien Testlaeufer; die reine Zuordnungsregel steckt in
 * `krypto/kanonischeAntwortId.ts` und ist dort getestet.
 */
import type { Message } from '$lib/api/types';

export function findeReplyZiel(nachrichten: Message[], replyToId: string): Message | undefined {
  return nachrichten.find((m) => m.id === replyToId || m.krypto_id === replyToId);
}
