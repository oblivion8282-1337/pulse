/**
 * Der letzte Ablehnungsgrund je Server — damit er bis in die Oberfläche reist.
 *
 * **Warum es diese Datei gibt.** `reauth()` kennt den Grund (`cert-invalid`,
 * `rate-limited`, `jwks_cold`, `join_not_permitted`, …), gab aber nur ein
 * `false` zurück; `client.ts` machte daraus „Anmeldung abgelaufen oder Server
 * nicht erreichbar". Am 2026-08-28 kostete das zwei Stunden Fehlersuche an einem
 * vollkommen gesunden Server — alle zehn Glieder der Erreichbarkeitsprüfung
 * grün, und die App sagte trotzdem „nicht erreichbar".
 *
 * Die Ablage ist bewusst ein schlichter Merker statt eines Rückgabewerts durch
 * die ganze Kette: `reauth` wird von zwei Stellen mit `boolean`-Vertrag gerufen
 * (`client.ts` und `gateway-connection.ts`), und beide Signaturen zu ändern
 * hätte den Umbau ohne Not vergrössert.
 *
 * Der Merker ist absichtlich kurzlebig: Er wird beim nächsten erfolgreichen
 * Anmelden gelöscht. Ein alter Grund, der einer neuen Störung vorgehalten wird,
 * wäre schlimmer als gar keiner.
 */

import { m } from '$lib/paraglide/messages.js';
import { MELDUNGSSCHLUESSEL, istAblehnungscode } from './anmelde-fehler-codes';
import type { Ablehnungscode } from './anmelde-fehler-codes';

const letzterGrund = new Map<string, Ablehnungscode>();

/** Ältere Gründe auf die heutigen Codes abbilden.
 *
 *  Der Zertifikats-Weg ist entfallen; diese Tabelle bleibt nur für Gründe, die
 *  weiterhin von woanders kommen können (`network`) oder in einem alten
 *  Zustand im Speicher liegen. Sie ist ausdrücklich KEIN Beleg dafür, dass es
 *  noch einen zweiten Anmeldeweg gäbe. */
const ALTE_GRUENDE_ZU_CODE: Record<string, Ablehnungscode> = {
  network: 'network',
  'join-closed': 'join_locked',
  'join-requires-invite': 'join_not_permitted',
  'instance-banned': 'instance banned',
};

export function merkeGrund(serverId: string, code: string): void {
  if (istAblehnungscode(code)) {
    letzterGrund.set(serverId, code);
    return;
  }
  const abgebildet = ALTE_GRUENDE_ZU_CODE[code];
  if (abgebildet) letzterGrund.set(serverId, abgebildet);
}

export function vergissGrund(serverId: string): void {
  letzterGrund.delete(serverId);
}

/**
 * Die lokalisierte Meldung zum letzten Grund, oder `null`.
 *
 * `null` heisst: Wir wissen es nicht — dann bleibt es bei der bisherigen
 * Sammelmeldung, die wenigstens nichts Falsches behauptet.
 */
export function meldungFuer(serverId: string): string | null {
  const code = letzterGrund.get(serverId);
  if (!code) return null;
  const schluessel = MELDUNGSSCHLUESSEL[code];
  const katalog = m as unknown as Record<string, (() => string) | undefined>;
  const fn = katalog[schluessel];
  return typeof fn === 'function' ? fn() : null;
}
