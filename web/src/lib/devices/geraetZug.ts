/**
 * Ziehen eines Standplatz-Geräts in einen anderen Sprachkanal.
 *
 * Bewusst der **gleiche** Mechanismus wie beim Ziehen eines Nutzers
 * (`voice/userDrag.ts`) und nicht ein zweiter daneben: die Kanalzeile trägt
 * bereits drei Ablege-Fälle (Kanal umsortieren, Nutzer verschieben, jetzt
 * Gerät umstellen), und die drei lassen sich nur auseinanderhalten, wenn jeder
 * seinen **eigenen MIME-Typ** mitbringt. `text/plain` gehört dem
 * Umsortieren — wer sich dort einklinkte, verschöbe beim Ablegen einen Kanal.
 *
 * Warum eigener Typ und nicht der Nutzer-Typ mit einem Präfix: `carriesUser`
 * hebt schon während `dragover` die Zielzeile hervor, lange bevor die Nutzlast
 * lesbar ist (`dataTransfer.types` steht vor dem Drop, die Daten erst beim
 * Drop). Mit einem geteilten Typ ließe sich vorher nicht sagen, WAS da kommt.
 */
export const GERAET_ZUG_MIME = 'application/x-pulse-device';

/** Die Gerätekennung in den Zug legen. Ohne `dataTransfer` ein No-op. */
export function startGeraetZug(e: DragEvent, deviceId: string): void {
  if (!e.dataTransfer) return;
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData(GERAET_ZUG_MIME, deviceId);
}

/** Wird gerade ein Gerät über das Ziel gezogen? Auch während `dragover` gültig. */
export function traegtGeraet(e: DragEvent): boolean {
  return !!e.dataTransfer && e.dataTransfer.types.includes(GERAET_ZUG_MIME);
}

/** Die gezogene Gerätekennung beim Ablegen, sonst `null`. */
export function gezogenesGeraet(e: DragEvent): string | null {
  return e.dataTransfer?.getData(GERAET_ZUG_MIME) || null;
}
