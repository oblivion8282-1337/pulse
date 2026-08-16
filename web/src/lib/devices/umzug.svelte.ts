/**
 * Standplatz umstellen — was nach dem Ablegen passiert.
 *
 * Getrennt von der Kanalliste, weil der Weg zwei Stufen hat: bei einem
 * **belegten** Gerät steht eine Nachfrage davor, und die braucht einen Zustand,
 * der den Dialog überlebt. In `ChannelList.svelte` wären das drei weitere
 * Zustandsvariablen in einer Datei, die davon schon genug hat.
 *
 * Drei Regeln, alle drei aus dem Verhalten des Servers abgeleitet:
 *
 * * **Umstellen darf nur der Besitzer.** Seit 2026-08-16 weist die Route einen
 *   Kanalwechsel durch andere ab — auch durch `MANAGE_GUILD` (`routes/devices.py`:
 *   der Standplatz ist der Rechteanker, die Verwaltung soll räumen können, nicht
 *   umwidmen). Verglichen wird gegen die **serverlokale** Kennung: `owner_user_id`
 *   ist eine solche, und auf einem Self-Host ist die Cloud-Kennung eine andere.
 * * **Ein Wechsel unterbricht eine laufende Übernahme** — der Server beendet die
 *   Sitzung, weil die Rechte am alten Kanal hingen. Das wortlos zu tun wäre die
 *   falsche Art von bequem, deshalb die Nachfrage.
 * * **Auf den eigenen Standplatz gezogen ist ein Nichts.** Kein Ruf, keine
 *   Meldung — der Server verwürfe die Änderung ohnehin, und eine Erfolgsmeldung
 *   für „nichts passiert" ist schlechter als Schweigen.
 *
 * Die Liste zieht **nicht** dieses Modul nach: der Server meldet den Wechsel
 * selbst an beide Kanäle (`device_changed`), und der WS-Handler spielt ihn ein.
 * Ein vorweggenommener Umzug wäre eine zweite Wahrheit, die bei jedem Fehlschlag
 * zurückgenommen werden müsste.
 */

import { toast } from 'svelte-sonner';
import { devicesApi, type Device } from '$lib/api/devices';
import { deviceStore } from '$lib/devices/store.svelte';
import { currentServerUserId } from '$lib/stores/currentServerUser';
import { m } from '$lib/paraglide/messages.js';
import type { Channel } from '$lib/api/types';

type Nachfrage = { guildId: string; geraet: Device; ziel: Channel };

class GeraeteUmzug {
  /** Offene Nachfrage zu einem belegten Gerät. `null` = kein Dialog. */
  nachfrage = $state<Nachfrage | null>(null);
  /** Läuft gerade ein Ruf? Hält Bestätigen und Abbrechen still. */
  laeuft = $state(false);

  /**
   * Ein Gerät wurde auf `ziel` abgelegt. Stellt um — oder fragt erst.
   *
   * Die Besitzerprüfung steht hier ein **zweites** Mal: die Zeile ist für
   * Fremde gar nicht erst ziehbar (`DeviceChannelRows`), aber ein Zug lässt
   * sich von Hand herstellen, und ein stiller Rücksprung ist billiger als eine
   * 403-Meldung für etwas, das die Oberfläche nie angeboten hat.
   */
  anfordern(guildId: string | null | undefined, deviceId: string, ziel: Channel): void {
    if (!guildId) return;
    const geraet = deviceStore.byId(guildId, deviceId);
    if (!geraet || geraet.channel_id === ziel.id) return;
    if (geraet.owner_user_id !== currentServerUserId()) return;
    if (geraet.state === 'busy') {
      this.nachfrage = { guildId, geraet, ziel };
      return;
    }
    void this.#umstellen(guildId, geraet, ziel);
  }

  /** „Trotzdem umstellen" im Dialog. */
  async bestaetigen(): Promise<void> {
    const offen = this.nachfrage;
    if (!offen || this.laeuft) return;
    await this.#umstellen(offen.guildId, offen.geraet, offen.ziel);
    // Erst nach dem Ruf schließen — sonst stünde der Dialog offen für ein
    // Gerät, dessen Umzug längst gescheitert ist, oder verschwände so früh,
    // dass die Fehlermeldung aus dem Nichts käme.
    this.nachfrage = null;
  }

  abbrechen(): void {
    if (this.laeuft) return;
    this.nachfrage = null;
  }

  async #umstellen(guildId: string, geraet: Device, ziel: Channel): Promise<void> {
    this.laeuft = true;
    try {
      await devicesApi.patch(guildId, geraet.id, { channel_id: ziel.id });
      toast.success(m.device_move_done({ device: geraet.name, channel: ziel.name }));
    } catch (err) {
      // Die Liste bleibt unangetastet: sie zeigt weiter den alten Standplatz,
      // und der stimmt — es hat sich ja nichts geändert.
      toast.error(m.device_move_failed(), {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      this.laeuft = false;
    }
  }
}

export const geraeteUmzug = new GeraeteUmzug();
