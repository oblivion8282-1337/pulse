/**
 * Der E2EE-Schlüsselweg eines Anrufs (2026-09-09): bei E2EE-fähigem Ziel
 * (verschlüsselte DM bzw. private Gruppe) erzeugt der Initiator EINEN
 * LiveKit-E2EE-Schlüssel (32 Zufallsbytes, `anrufSchluessel.ts`) und
 * verschickt ihn als Anruf-Schlüssel-Frame über das verschlüsselte Postfach
 * (`schluesselVerteilen.ts`) — misslingt die Zustellung, bricht der Anruf ab
 * (fail-closed, kein unverschlüsselter Anruf). Der Angerufene wartet nach
 * der Annahme auf den Schlüssel (`schluesselWarten.ts`), bevor er mit der
 * `encryption`-Room-Option verbindet; Schlüssel liegen NUR im
 * Arbeitsspeicher (`AnrufSchluesselBund`). Klartext-DMs (Schalter aus)
 * laufen wie bisher ohne Schlüssel — transportverschlüsselt, ehrlich im
 * Overlay benannt.
 *
 * Aus `anruf.svelte.ts` herausgelöst (Grössen-Policy). Schlichtes `.ts`,
 * ohne Runes — den Warte-Hinweis fürs Overlay (`schluesselWarten`) hält der
 * Zustand selbst.
 */

import type { AnrufArt } from '$lib/api/anrufe';
import { E2E_DMS_ENABLED, PRIVATE_GRUPPEN_ENABLED } from '$lib/krypto/schalter';
import { istAnrufSchluessel, neuAnrufSchluessel } from './anrufSchluessel';
import { anrufSchluesselVerteilen } from './schluesselVerteilen';
import { warteAufAnrufSchluessel } from './schluesselWarten';

/** E2EE-fähiges Ziel? Bei DMs entscheidet der DM-Schalter, bei Gruppen der
 *  Gruppen-Schalter — ist einer aus, gibt es dort schlicht keinen
 *  verschlüsselten Weg (Klartext-DM), und der Anruf läuft ohne Schlüssel. */
export function e2eeFaehig(art: AnrufArt): boolean {
  return art === 'gruppe' ? PRIVATE_GRUPPEN_ENABLED : E2E_DMS_ENABLED;
}

/** Die Anruf-Schlüssel dieses Fensters, `anrufId → base64`. */
export class AnrufSchluesselBund {
  /** Gefüllt vom Empfangs-Dispatch (`empfangen.ts::schluesselEmpfangen`)
   *  und vom Initiator in `verteilen`.
   *  ponytail: Einträge von Anrufen, die dieses Gerät nie führte (fremde
   *  Gruppenanrufe, eigenes Zweitgerät), bleiben bis zum Seitenende stehen —
   *  je Eintrag 32 Bytes; Aufräumen per Altersliste wäre der Ausbau, falls
   *  das je sichtbar wird. */
  #schluessel = new Map<string, string>();

  /** Für einen ausgehenden Anruf: ein frischer Schlüssel, wenn das Ziel E2EE
   *  kann, sonst `null`. JETZT erzeugt — die ID des Anrufs kennt erst der
   *  Server, der Schlüsselinhalt kommt vom Initiator. */
  neu(art: AnrufArt): string | null {
    return e2eeFaehig(art) ? neuAnrufSchluessel() : null;
  }

  /** Einen empfangenen Schlüssel merken — fail-closed, nur sauber
   *  dekodierbare 32-Byte-Schlüssel (`istAnrufSchluessel`). */
  empfangen(anrufId: string, schluessel: string): void {
    if (anrufId === '' || !istAnrufSchluessel(schluessel)) return;
    this.#schluessel.set(anrufId, schluessel);
  }

  holen(anrufId: string): string | null {
    return this.#schluessel.get(anrufId) ?? null;
  }

  vergessen(anrufId: string): void {
    this.#schluessel.delete(anrufId);
  }

  /** Den eigenen Schlüssel merken und an die Gegenseite verschicken. Wirft,
   *  wenn nichts zugestellt wurde — der Aufrufer bricht ab (fail-closed). */
  async verteilen(art: AnrufArt, kanalId: string, anrufId: string, schluessel: string): Promise<void> {
    this.#schluessel.set(anrufId, schluessel);
    await anrufSchluesselVerteilen(art, kanalId, anrufId, schluessel);
  }

  /** Nach der Annahme auf den Schlüssel des Anrufers warten — `null` nach
   *  der Frist (fail-closed). Stösst vorher die Postfach-Abholung an
   *  (bestehender Einstiegspunkt, dynamisch importiert — der WS-Weckruf
   *  `postfach_neu` hat sie meist schon angestossen; hier doppelt sich
   *  nichts, der Nachlauf dedupliziert). */
  abwarten(anrufId: string): Promise<string | null> {
    void import('$lib/krypto/empfangen')
      .then(({ postfachAbholenUndEntschluesseln }) => postfachAbholenUndEntschluesseln())
      .catch(() => {});
    return warteAufAnrufSchluessel(() => this.holen(anrufId));
  }
}
