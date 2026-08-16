/**
 * Standplatz-Geräte — wie ein Zustand aussieht und wo ein Gerät wohnt.
 *
 * Drei Stellen zeigen dasselbe Gerät (Kanalliste, Mitgliederliste,
 * Geräteansicht), und ohne diese Datei entstand die Abbildung
 * „Zustand → Farbe/Text" in jeder von ihnen neu. Beim ersten Mal ist das
 * Bequemlichkeit, beim dritten Mal laufen die Farben auseinander — und die
 * Farbe ist hier keine Zierde: sie beantwortet „kann ich diesen Rechner jetzt
 * übernehmen".
 */

import type { Device, DeviceState } from '$lib/api/devices';
import { deviceStore } from '$lib/devices/store.svelte';
import { m } from '$lib/paraglide/messages.js';

/**
 * Farbe des Zustandspunkts.
 *
 * Bereit ist das einzige Grün — belegt ist kein Fehler, aber auch keine
 * Einladung, und offline ist schlicht still.
 */
export function punktKlasse(state: DeviceState): string {
  if (state === 'ready') return 'bg-emerald-500';
  if (state === 'busy') return 'bg-amber-500';
  return 'bg-text-muted/40';
}

/**
 * Zustand als Text. `wer` ist der Name des Steuernden, sofern bekannt — nur
 * die Mitgliederliste hat Platz dafür, die Kanalliste zeigt den kurzen Text.
 */
export function zustandsText(state: DeviceState, wer?: string | null): string {
  if (state === 'busy') {
    return wer ? m.device_member_busy_with({ user: wer }) : m.device_state_busy();
  }
  return state === 'ready' ? m.device_state_ready() : m.device_state_offline();
}

/**
 * Wo ein Gerät wohnt.
 *
 * Der Kanal in der Adresse bleibt der Standplatz — das Gerät gehört dorthin,
 * und die Kanalliste hebt beides zusammen hervor. Dass die Kennung als
 * Abfrageteil (`?device=`) und nicht als eigener Pfad steht, hält die
 * Geräteansicht in derselben Ansicht wie den Kanal: Zurück-Knopf, Neuladen und
 * Verlinken tun, was man erwartet, ohne eine zweite Route mit derselben
 * Umgebung.
 */
export function geraetPfad(device: Device): string {
  return `/app/guilds/${device.guild_id}/channels/${device.channel_id}?device=${device.id}`;
}

/**
 * Sendet in diesem Kanal in Wahrheit das **Gerät** dieses Nutzers?
 *
 * Der Strom eines Standplatz-Geräts läuft unter dem Konto seines Besitzers — im
 * Streaming-Weg gibt es keine Geräte-Kennung (`stream/starten.ts`). Ungefiltert
 * heisst das: das LIVE-Abzeichen erscheint **zweimal**, einmal am Rechner und
 * einmal am Menschen, der dabei nicht einmal im Kanal sein muss. Zweimal
 * dasselbe anzuzeigen ist nicht nur unsauber, es ist an einer Stelle falsch —
 * gesendet hat der Rechner.
 *
 * Erkannt am Standplatz, nicht am Strom: steht ein Gerät dieses Besitzers in
 * diesem Kanal, gehört ein HQ-Strom dieses Kontos dorthin. Der Grenzfall — der
 * Besitzer überträgt zusätzlich von seinem Laptop in denselben Kanal — endet
 * dann bei einem Abzeichen statt zwei, und zwar am Gerät. Erreichbar bleibt
 * beides: der Klick öffnet die Auswahl, sobald mehr als ein Strom läuft.
 *
 * **Ein geteilter Bildschirm über Voice ist davon nicht betroffen** — der
 * läuft über LiveKit und wird an den Aufrufstellen getrennt geführt.
 */
export function stromGehoertGeraet(channelId: string, userId: string): boolean {
  return deviceStore.byChannelOwner(channelId, userId) !== null;
}
