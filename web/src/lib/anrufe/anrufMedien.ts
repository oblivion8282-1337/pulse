/**
 * Der Medienweg eines Anrufs — die Naht zwischen Signalisierung und Raum.
 *
 * Der Anruf-Zustand (`anruf.svelte.ts`) führt die Signalisierung (Server,
 * Schlüssel, Klingeln, Systemzeile); WO der LiveKit-Raum läuft, entscheidet
 * er einmal je Anruf und spricht danach nur noch diese Schnittstelle:
 *
 * - **Web** (`webAnrufRaum.ts`): `livekit-client` in der WebView — Browser,
 *   Electron, Android und iOS-Bauten ohne nativen Raum.
 * - **Nativ** (`nativerAnrufRaum.ts`): der Raum der iOS-Hülle unter CallKit
 *   (Etappe 4, Entwurf `docs/superpowers/specs/2026-10-10-ios-nativer-
 *   sprachweg-design.md`).
 *
 * **Warum eine Naht und kein dritter Zweig in jeder Methode:** der Zustand
 * hat sechs Stellen, die den Raum anfassen; mit Weichen in jeder wären es
 * zwölf, und die Hälfte davon nur auf einem iPhone prüfbar.
 *
 * Nur Typen — importfrei (CLAUDE.md, `pnpm test:unit`).
 */

import type { AnrufArt } from '$lib/api/anrufe';

export type Rolle = 'ausgehend' | 'eingehend';

export type LaufenderAnruf = {
  id: string;
  art: AnrufArt;
  channel_id: string;
  rolle: Rolle;
  gegenstelle: string;
  zustand: 'klingelt' | 'verbunden';
};

/** Was der Medienweg dem Zustand meldet. */
export interface AnrufMedienHaken {
  /** Der Raum ist verbunden (auch erneut nach einem Wiederaufbau). */
  verbunden(): void;
  /** Der Raum ist unerwartet weg (Rauswurf, Netz endgültig verloren). */
  verloren(): void;
  /** Wie der Anruf verschlüsselt ist. `endgueltig: false` setzt nur, wenn
   *  noch nichts bekannt ist (die Ableitung nach dem Verbinden); das
   *  Live-Ereignis des Raums überschreibt immer. */
  verschluesselung(art: 'e2ee' | 'transport', endgueltig: boolean): void;
  /** Nur nativ: der Stand der Hülle — Mikrofon, Kamera und Ausgabe können
   *  sich dort ohne die Oberfläche ändern (Stummschalter im CallKit-
   *  Bildschirm, AirPods). */
  stand(s: { stumm: boolean; kamera: boolean; lautsprecher: boolean }): void;
}

export interface AnrufMedien {
  /** Läuft der Raum nativ? Treibt die Oberfläche (Ausgabe-Knopf). */
  readonly nativ: boolean;
  /** Ein ausgehender Anruf hat seine Kennung. */
  vorbereitenAusgehend(anruf: LaufenderAnruf): Promise<void>;
  /** In der App angenommen — VOR dem Verbinden. */
  vorbereitenAnnahme(anruf: LaufenderAnruf): Promise<void>;
  /** Den Raum betreten. `aktuell()` sagt, ob der Anruf inzwischen abgebaut
   *  wurde — dann gehört der Raum niemandem mehr. */
  verbinden(
    anruf: LaufenderAnruf,
    zugang: { ws_url: string; token: string },
    schluessel: string | null,
    stumm: boolean,
    aktuell: () => boolean
  ): Promise<void>;
  mikrofon(an: boolean): Promise<void>;
  kamera(an: boolean): Promise<void>;
  /** Lautsprecher (true) oder Hörmuschel. Nur nativ wirksam. */
  ausgabe(lautsprecher: boolean): Promise<void>;
  /** Alles freigeben. Idempotent, wirft nie. */
  trennen(): void;
}
