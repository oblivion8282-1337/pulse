/**
 * Standplatz-Geräte — **Übertragung auf Abruf**.
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
 * `remote_request`**. In der Oberfläche darf das ein Klick sein (die
 * Geräteansicht macht daraus einen); im Protokoll und in den Fehlern bleiben es
 * zwei, die sich einzeln lesen lassen.
 *
 * ## Zwei Seiten
 *
 * * **Wer weckt** schickt `device_wake`. Der Gateway prüft `REMOTE_CONTROL` am
 *   Standplatz und reicht den Ruf an die Verbindungen des Geräts weiter.
 * * **Das Gerät** hört den Ruf und startet die Übertragung in seinem Kanal —
 *   über denselben Weg wie der Knopf „Übertragen" (`stream/starten.ts`).
 */

import { gatewayForServer } from '$lib/ws/connection';
import { geraeteAnmeldung } from './anmeldung.svelte';
import { streamStarten } from '$lib/stream/starten';
import { nextFreeStreamSlot } from '$lib/stream/slotControl.svelte';
import { runningStreamSlots } from '$lib/stream/state.svelte';

/**
 * Einen Weckruf absetzen. `false` = nicht hinausgegangen (keine Verbindung);
 * eine Ablehnung des Gateways kommt dagegen als `op:'error'` zurück und wird
 * dort behandelt, wo auch die übrigen Fernsteuer-Fehler landen.
 */
export function geraetWecken(serverId: string | null, deviceId: string): boolean {
  const conn = serverId ? gatewayForServer(serverId) : null;
  if (!conn) return false;
  try {
    return conn.sendDeviceWake(deviceId);
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
 *
 * **Läuft schon eine Übertragung, passiert nichts.** Der Regelfall dafür ist
 * ein zweiter Weckruf, während der erste noch anläuft: zwei Streams desselben
 * Geräts wären zwei Kacheln, von denen eine niemanden interessiert.
 */
export async function weckrufBehandeln(
  serverId: string | null,
  deviceId: string,
  channelId: string,
): Promise<void> {
  const eintrag = geraeteAnmeldung.fuerServer(serverId);
  if (!eintrag || eintrag.deviceId !== deviceId) return;
  if (runningStreamSlots().length > 0) return;
  await streamStarten(channelId, nextFreeStreamSlot());
}
