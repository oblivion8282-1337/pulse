/**
 * Einen HQ-Stream starten — der Kern, ohne Oberfläche.
 *
 * Herausgelöst aus `components/StreamControls.svelte`, weil es seit den
 * Standplatz-Geräten **zwei** Anlässe gibt, einen Stream zu beginnen: der
 * Mensch, der auf „Übertragen" klickt, und das Gerät, das aus der Ferne
 * geweckt wird (`$lib/devices/wecken.ts`). Beide brauchen exakt dieselbe
 * Reihenfolge — Token holen, Argumente bauen, Sidecar starten, Kanal für den
 * Auto-Neustart merken —, und ein zweiter Nachbau davon wäre die Sorte
 * Doppelung, die irgendwann auseinanderläuft.
 *
 * **Ohne Meldungen.** Die Fehlertexte des Knopfes hängen an seinen eigenen
 * Zuständen (Toast, Fehlerzeile im Dialog); das Wecken meldet ganz anders
 * (der Steuernde sitzt woanders). Deshalb liefert diese Datei den ROHEN Fehler
 * samt Stufe zurück und deutet ihn nicht.
 */

import { chatApi } from '$lib/api/chat';
import { gsr } from './gsr';
import { buildStartArgs, pushProtokoll, tenBitPossible } from './settings.svelte';
import { resolveSlotLabel } from './label';
import { recordStreamStart } from './autoRestart';
import { stream } from './state.svelte';

export type StartErgebnis =
  | { ok: true }
  /** `stufe` trennt die beiden Fehlerquellen, weil sie ganz verschiedene
   *  Ursachen haben: `token` ist der Server (kein Mitglied, kein Sprachkanal,
   *  media-svc weg), `start` der Sidecar auf diesem Rechner. */
  | { ok: false; stufe: 'token' | 'start'; fehler: unknown };

/**
 * Übertragung in `channelId` auf `slot` beginnen.
 *
 * Wirft nicht — jeder Fehlschlag kommt als Ergebnis zurück. Beide Aufrufer
 * stehen in Pfaden, die danach noch aufräumen oder melden müssen.
 */
export async function streamStarten(channelId: string, slot: number): Promise<StartErgebnis> {
  let tok;
  try {
    // Den lesbaren Namen (etwa „Monitor 1", „Chrome") einmal beim Start
    // auflösen, damit die Auswahl der Zuschauer den Stream benennen kann, ohne
    // die GSR-Kataloge zu haben.
    const label = resolveSlotLabel(slot).label;
    tok = await chatApi.getStreamToken(
      channelId,
      // Warum Betriebsart UND Codec den Transport mitentscheiden: s. `pushProtokoll`.
      pushProtokoll(),
      slot,
      label,
      tenBitPossible(),
      // Ferngesteuert werden kann nur, wessen Sidecar Eingaben einspielen kann —
      // heute allein der Windows-Sidecar. Der Wert reist mit dem Stream bis zum
      // Zuschauer und entscheidet dort, ob der Anfrage-Knopf erscheint.
      stream.fernsteuerbar,
    );
  } catch (fehler) {
    return { ok: false, stufe: 'token', fehler };
  }

  try {
    const args = buildStartArgs({ channelId, token: tok.token, pushUrl: tok.push_url }, slot);
    const r = await gsr.start(args, slot);
    if (r && !r.ok) return { ok: false, stufe: 'start', fehler: r.error };
    // Den Kanal für den Auto-Neustart nach einer Auflösungsänderung merken —
    // `autoRestart.ts` erfährt ihn sonst nirgends.
    recordStreamStart(slot, channelId);
    return { ok: true };
  } catch (fehler) {
    return { ok: false, stufe: 'start', fehler };
  }
}
