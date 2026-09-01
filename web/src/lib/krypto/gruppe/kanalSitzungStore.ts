/**
 * Verwaltung der `KanalSitzungState`-Objekte je Ablage-Kanal — die
 * Verdrahtung, die `kanalSitzungswahl.ts`s Modulkopf als „Aufgabe 5/Chat-
 * Anbindung" ankündigt: EIN Eintrag je Kanal, angelegt beim ersten Zugriff,
 * gefüttert von der Chat-Seite mit WS-Ereignissen
 * (`kanalEreignisEinspeisen`).
 *
 * **Modulweiter Zustand ist hier Absicht, kein Svelte-Rune-Zustand.** Die
 * Chat-Seite (`routes/app/guilds/[guildId]/channels/[channelId]/+page.svelte`)
 * wird beim Kanalwechsel wiederverwendet statt neu gemountet — ein
 * `$state` in der Seite selbst würde beim Verlassen und Zurückkommen
 * verloren gehen, obwohl die Megolm-Sitzung (in IndexedDB) weiterlebt.
 * Der Zustand hier ist reine Buchhaltung (Mitgliederliste + Überholt-Flag,
 * s. `kanalSitzungswahl.ts`), kein UI-Zustand — deshalb genügt eine
 * modulweite `Map`, keine Runen nötig.
 *
 * **`neueGruppensitzung` kommt hier nur als TYP herein** (`import type`),
 * nicht als Wert — sonst zöge dieses Modul den WASM-Krypto-Kern
 * (`gruppenSitzungen.ts` importiert ihn) beim blossen Einbinden mit, obwohl
 * dieser Store auch ohne eine einzige Sendung leben muss: der WS-Ereignis-
 * Einspeiser (`kanalEreignisEinspeisen`) läuft auf der Chat-Seite ab dem
 * ersten Mount, lange bevor je gesendet wird. Genau dieselbe Sorge wie in
 * `sendenMitAnzeige.ts` („WASM aus dem Start heraushalten"), hier nur eine
 * Ebene tiefer.
 *
 * **Jeder Eintrag trägt seine `guildId` mit.** `kanalEreignisEinspeisen`
 * geht über ALLE bekannten Kanäle, nicht nur den gerade aktiven — ein
 * WS-Ereignis für einen Kanal, den der Nutzer gerade nicht offen hat (z. B.
 * eine Rollenänderung in einer anderen Community, während er woanders
 * schreibt), muss die dortige Sitzung trotzdem als überholt markieren,
 * sonst sendet die nächste Nachricht dort mit einer veralteten
 * Mitgliederliste. Ohne die `guildId` je Eintrag könnte
 * `machtKanalUeberholt` den Guild-Abgleich nicht durchführen.
 */
import {
  neuerKanalSitzungState,
  kanalEreignisVerarbeiten,
  type KanalSitzungState,
  type KanalWechselEreignis
} from './kanalSitzungswahl';
import type { neueGruppensitzung } from './gruppenSitzungen';

type Zustand = KanalSitzungState<ReturnType<typeof neueGruppensitzung>>;

const eintraege = new Map<string, { guildId: string; state: Zustand }>();

/** Liefert (und legt bei Bedarf an) den Sitzungs-Zustand für `kanalId` in
 *  `guildId`. Derselbe Aufruf dient dem Senden (`kanalSenden.ts`) und dem
 *  Einspeisen von WS-Ereignissen. */
export function kanalSitzungState(guildId: string, kanalId: string): Zustand {
  const bestehend = eintraege.get(kanalId);
  if (bestehend) return bestehend.state;
  const state = neuerKanalSitzungState<ReturnType<typeof neueGruppensitzung>>();
  eintraege.set(kanalId, { guildId, state });
  return state;
}

/** Speist ein WS-Ereignis in JEDEN bislang bekannten Kanal-Zustand ein —
 *  s. Modulkopf, warum nicht nur den aktiven Kanal. Rein bis auf die
 *  Überholt-Markierung; kein Netzaufruf, keine Rückwirkung, wenn noch kein
 *  Zustand für den betroffenen Kanal existiert (dann holt die erste
 *  Sendung ohnehin frisch, s. `kanalSitzungswahl.ts`). */
export function kanalEreignisEinspeisen(evt: KanalWechselEreignis): void {
  for (const [kanalId, { guildId, state }] of eintraege) {
    kanalEreignisVerarbeiten(state, evt, guildId, kanalId);
  }
}
