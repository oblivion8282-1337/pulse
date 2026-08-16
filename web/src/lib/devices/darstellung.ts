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
