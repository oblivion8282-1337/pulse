/**
 * Den Anruf-Schlüssel verteilen (E2EE-Anrufe, 2026-09-09) — an alle Geräte
 * der Gegenseite, DM per Olm, Gruppe per Megolm. Gegenstück auf der
 * Empfängerseite: `schluesselWarten.ts`.
 *
 * Dynamisch importiert (Muster wie `systemzeileSenden`): die Sendekette zieht
 * den halben Krypto-Stack nach sich, und der Anruf-Zustand lädt sie erst,
 * wenn wirklich verschickt wird.
 *
 * Aus `anruf.svelte.ts` herausgelöst (Grössen-Policy).
 */

import type { AnrufArt } from '$lib/api/anrufe';

/** Wirft, wenn nichts zugestellt wurde — der Aufrufer bricht den Anruf ab
 *  (fail-closed, kein unverschlüsselter Anruf). */
export async function anrufSchluesselVerteilen(
  art: AnrufArt,
  kanalId: string,
  anrufId: string,
  schluessel: string
): Promise<void> {
  const nichtZustellbar = () => new Error('Anruf-Schlüssel nicht zustellbar');
  if (art === 'gruppe') {
    const { sendeGruppenAnrufSchluessel } = await import('$lib/krypto/gruppe/frameSenden');
    if (!(await sendeGruppenAnrufSchluessel(kanalId, anrufId, schluessel))) {
      throw nichtZustellbar();
    }
    return;
  }
  const { directMessages } = await import('$lib/stores/directMessages.svelte');
  const empfaenger = directMessages.byId[kanalId]?.other_user_id;
  if (!empfaenger) throw nichtZustellbar();
  const { sendeAnrufSchluessel } = await import('$lib/krypto/senden');
  if (!(await sendeAnrufSchluessel(kanalId, empfaenger, anrufId, schluessel))) {
    throw nichtZustellbar();
  }
}
