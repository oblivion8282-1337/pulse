/**
 * Wer im laufenden Kanal von der Moderation stumm- oder taubgeschaltet ist —
 * in der Form, die die native Kanalansicht der iOS-Hülle bekommt
 * (`SprachePlugin.erzwungen`).
 *
 * **Warum die Hülle das aus dem Web erfährt.** LiveKit kennt nur die
 * Stummschaltung, und auch die nur als entzogenes Recht, die Mikrofonspur zu
 * veröffentlichen — dasselbe Recht fehlt jemandem, der im Kanal schlicht nicht
 * sprechen darf. Die Taubschaltung kennt LiveKit gar nicht, sie ist eine Bitte
 * an den Klienten. Die Wahrheit über beides steht in `voicePresence`
 * (`voice_override` über die WebSocket). Ohne sie zeigte die native Ansicht
 * ein gewöhnliches Stumm-Zeichen und einen Knopf, der beim Tippen still nichts
 * tat (das Web lehnt das Einschalten ab, `toggleMic`).
 *
 * Importfrei (CLAUDE.md, `pnpm test:unit`).
 */

export type Override = { muted: boolean; deafened: boolean };
export type Erzwungen = { stumm: string[]; taub: string[] };

/** Die Overrides EINES Kanals (`voicePresence.overrideByChannel[kanal]`) als
 *  zwei sortierte Listen von Nutzer-Ids. Sortiert, damit derselbe Stand
 *  gleich aussieht, egal in welcher Reihenfolge er ankam. */
export function erzwungenAus(overrides: Record<string, Override> | undefined): Erzwungen {
  const stumm: string[] = [];
  const taub: string[] = [];
  for (const [nutzer, o] of Object.entries(overrides ?? {})) {
    if (o.muted) stumm.push(nutzer);
    if (o.deafened) taub.push(nutzer);
  }
  return { stumm: stumm.sort(), taub: taub.sort() };
}

/** Schon so an die Hülle gegangen? `null` heisst: in diesem Raum noch nichts. */
export function gleichErzwungen(a: Erzwungen | null, b: Erzwungen): boolean {
  if (a === null) return false;
  return a.stumm.join(',') === b.stumm.join(',') && a.taub.join(',') === b.taub.join(',');
}
