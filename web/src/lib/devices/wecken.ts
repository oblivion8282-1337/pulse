/**
 * Standplatz-Geräte — **Übertragung auf Abruf, ein Bildschirm nach dem anderen**.
 *
 * Ein Gerät überträgt nicht rund um die Uhr: ein Rechner, der für niemanden
 * encodiert, verbraucht Strom und Rechenzeit für nichts. Es fängt an, wenn
 * jemand es wecken will.
 *
 * ## Warum das nicht die Fernsteuer-Anfrage selbst tut
 *
 * Naheliegend wäre, `remote_request` als Weckruf zu nehmen. Dagegen spricht ein
 * konkreter Fehlerfall (Entwurf §8): dann hinge eine **Sitzungszusage an einer
 * Encoder-Initialisierung**. Scheitert die — kein Monitor angeschlossen,
 * Encoder belegt, Startverweigerung wegen HDR oder Intra-Refresh —, stünde eine
 * aktive Fernsteuer-Sitzung ohne Bild da, und der Fehler wäre nicht lesbar.
 *
 * Deshalb zwei Vorgänge: **wecken → übertragen → dann die unveränderte
 * `remote_request`**.
 *
 * ## Mehrere Bildschirme
 *
 * Wie bei Parsec: der erste Weckruf holt den **Hauptbildschirm**, die weiteren
 * schaltet der Steuernde in der laufenden Sitzung dazu — je Bildschirm eine
 * eigene Übertragung, also eine eigene Kachel und ein eigenes Player-Fenster.
 * Das ist nicht nur bequemer als „alles in einem Bild", es ist auf Windows der
 * einzige Weg: Windows Graphics Capture nimmt immer genau einen Schirm auf
 * (`ops/start.rs::parse_capture`).
 *
 * Gezielt wird trotzdem richtig, ohne dass hier etwas dafür zu tun wäre: der
 * Drahtvertrag trägt die Platznummer in JEDER Eingabe-Nachricht, und der
 * Sidecar rechnet die Anteile in das Rechteck des jeweils gemeinten Schirms
 * (`remote_input/zuordnung.rs`). Eine Sitzung kann deshalb mehrere Bildschirme
 * bedienen — es braucht keine zweite.
 *
 * ## Der Ton geht genau einmal hinaus
 *
 * Der **erste** Bildschirm einer Sitzung trägt den Systemton, jeder
 * dazugeschaltete ist stumm. Sonst käme derselbe Ton zwei- oder dreifach beim
 * Steuernden an, leicht gegeneinander versetzt — das klingt schlechter als gar
 * keiner, und es kostet je Strom eine eigene Tonspur.
 */

import { gatewayForServer } from '$lib/ws/connection';
import { geraeteAnmeldung } from './anmeldung.svelte';
import { HAUPTBILDSCHIRM, standplatzProfil } from './profil.svelte';
import { streamStarten } from '$lib/stream/starten';
import { nextFreeStreamSlot } from '$lib/stream/slotControl.svelte';
import { runningStreamSlots } from '$lib/stream/state.svelte';
import { MONITOR_CAPTURE_PREFIX } from '$lib/stream/settingsCatalog';
import { streamSettings } from '$lib/stream/settingsState.svelte';

/**
 * Welcher Platz welchen Bildschirm überträgt — nur auf dem GERÄT geführt.
 *
 * Verhindert das eine, was sonst leicht passiert: ein zweiter Weckruf für
 * denselben Schirm (Doppelklick, oder der Steuernde drückt nochmal, weil das
 * Bild noch nicht da ist) startet eine zweite Übertragung desselben Inhalts.
 * Gegen die laufenden Plätze abgeglichen statt selbst aufgeräumt — ein Platz,
 * der nicht mehr läuft, zählt damit von selbst nicht mehr.
 */
const platzFuerQuelle = new Map<number, string>();

/**
 * Aufnahmequelle für eine Bildschirmnummer; ohne Nummer die des Profils.
 *
 * **Der Hauptbildschirm wird dabei auf seine Nummer aufgelöst**, sobald der
 * Rechner seine Schirme kennt. Ohne das hiesse die Quelle schlicht „monitor",
 * und daran hängen zwei Dinge, die dann nicht mehr stimmen: der Name der
 * Kachel beim Steuernden (er hiesse „Stream 1" statt „Monitor 1"), und die
 * Erkennung, ob dieser Schirm schon läuft — ein Weckruf mit ausdrücklicher
 * Nummer 1 wäre sonst eine andere Quelle als derselbe Schirm ohne Nummer und
 * startete ihn ein zweites Mal.
 */
function quelleFuerMonitor(monitor: number | undefined): string {
  if (monitor !== undefined) return `${MONITOR_CAPTURE_PREFIX}${monitor}`;
  const eigene = standplatzProfil.profil.quelle;
  if (eigene !== HAUPTBILDSCHIRM) return eigene;
  const haupt = streamSettings.available_monitors.find((mon) => mon.primary);
  return haupt ? `${MONITOR_CAPTURE_PREFIX}${haupt.index}` : eigene;
}

/** Läuft diese Quelle schon? */
function laeuftSchon(quelle: string): boolean {
  const laufend = new Set(runningStreamSlots());
  for (const [slot, q] of platzFuerQuelle) {
    if (laufend.has(slot) && q === quelle) return true;
  }
  return false;
}

/**
 * Einen Weckruf absetzen. `false` = nicht hinausgegangen (keine Verbindung);
 * eine Ablehnung des Gateways kommt dagegen als `op:'error'` zurück und wird
 * dort behandelt, wo auch die übrigen Fernsteuer-Fehler landen.
 *
 * `monitor` ist die Nummer aus der Bildschirmliste des Geräts; ohne Angabe
 * nimmt es seinen Hauptbildschirm.
 */
export function geraetWecken(
  serverId: string | null,
  deviceId: string,
  monitor?: number,
): boolean {
  const conn = serverId ? gatewayForServer(serverId) : null;
  if (!conn) return false;
  try {
    return conn.sendDeviceWake(deviceId, monitor);
  } catch {
    return false;
  }
}

/**
 * Das Gerät ist gemeint und soll anfangen zu übertragen.
 *
 * **Prüft zuerst, ob es wirklich um DIESEN Rechner geht.** Der Ruf kommt über
 * die eigene Verbindung herein und ist damit vertrauenswürdig, aber ein Fenster
 * desselben Kontos auf einem anderen Rechner darf sich davon nicht angesprochen
 * fühlen — sonst begänne der Laptop des Besitzers zu übertragen, weil jemand
 * den Werkstatt-PC wecken wollte.
 */
export async function weckrufBehandeln(
  serverId: string | null,
  deviceId: string,
  channelId: string,
  monitor?: number,
): Promise<void> {
  const eintrag = geraeteAnmeldung.fuerServer(serverId);
  if (!eintrag || eintrag.deviceId !== deviceId) return;

  const quelle = quelleFuerMonitor(monitor);
  if (laeuftSchon(quelle)) return;

  // Der erste Bildschirm trägt den Ton, jeder weitere ist stumm (s. Modulkopf).
  // **Mit dem Standplatz-Profil, nicht mit den Einstellungen des Besitzers:**
  // der Rechner überträgt hier für jemand anderen und zu einem anderen Zweck
  // als beim Vorführen (Begründung in `profil.svelte.ts`).
  const erster = runningStreamSlots().length === 0;
  const slot = nextFreeStreamSlot();
  platzFuerQuelle.set(slot, quelle);
  const r = await streamStarten(channelId, slot, {
    quelle,
    uebersteuerung: standplatzProfil.alsUebersteuerung(),
    ton: erster ? 'Desktop' : 'Aus',
  });
  // Scheitert der Start, gehört der Platz nicht diesem Schirm — sonst hielte
  // die Karte ihn für belegt, und ein zweiter Versuch liefe ins Leere.
  if (!r.ok) platzFuerQuelle.delete(slot);
}
