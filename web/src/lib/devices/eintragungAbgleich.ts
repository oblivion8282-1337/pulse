/**
 * Tote lokale Geräte-Eintragungen erkennen.
 *
 * Eine Eintragung (`anmeldung.svelte.ts`) lebt ausschliesslich auf dem
 * Rechner. Der Server bestätigt sie nie: `device_announce` verwirft eine
 * fremde oder verschwundene Kennung **still** (`ws_device_handlers.py`,
 * Modulkopf „Fremde oder verschwundene Zeile"). Damit gibt es genau einen
 * Weg, wie eine Eintragung von selbst verschwindet — die
 * `device_changed`-Meldung mit `removed` (`nachzugAktion.ts`). Und die
 * erreicht nur, wer die Community noch sieht.
 *
 * Wer aus der Community fliegt, sie verlässt oder deren Löschung verpasst,
 * behält deshalb eine Eintragung, die nichts mehr bedeutet — und der
 * Standplatz-Reiter bleibt für immer im Zustand „schon eingetragen", mit
 * einer leeren Kanalauswahl und ohne Weg zurück (Bughunt 2026-08-21).
 *
 * Hier steht nur die ENTSCHEIDUNG, importfrei für Nodes Testläufer; das
 * Räumen bleibt in `anmeldung.svelte.ts`.
 *
 * **Beide Funktionen antworten auf eine leere Liste mit „nichts ist tot".**
 * Das ist die wichtigste Zeile in dieser Datei: „ich kenne keine einzige
 * Community" ist von „die Liste ist mir gar nicht erst zugegangen" nicht zu
 * unterscheiden, und die beiden Irrtümer kosten Verschiedenes. Eine tote
 * Eintragung eine Sitzung länger stehen zu lassen ist ein Schönheitsfehler;
 * eine LEBENDE zu räumen nimmt einem Standplatz-Gerät die Anmeldung, und
 * niemand sitzt davor, um es neu einzutragen.
 */

/** Was der Abgleich von einer Eintragung braucht. */
export interface AbgleichEintragung {
  serverId: string;
  guildId: string;
  deviceId: string;
}

/**
 * Eintragungen, deren Community es für diesen Nutzer nicht mehr gibt.
 *
 * `guildIds` muss die **vollständige** Communityliste dieses Servers sein —
 * im Client ist das der `ready`-Rahmen, der laut `ws/handlers/ready.ts` die
 * alleinige Wahrheit über die Communityliste ist und dort auch schon
 * verschwundene Communitys aus dem Store wirft. Nur eine solche Liste macht
 * „nicht enthalten" zu einer Aussage statt zu einer Vermutung.
 */
export function verwaisteDurchCommunity(
  eintragungen: readonly AbgleichEintragung[],
  serverId: string,
  guildIds: readonly string[],
): string[] {
  if (guildIds.length === 0) return [];
  const bekannt = new Set(guildIds);
  return eintragungen
    .filter((e) => e.serverId === serverId && !bekannt.has(e.guildId))
    .map((e) => e.deviceId);
}

/**
 * Eintragungen, deren Server gar nicht mehr in der Serverliste steht.
 *
 * Entsteht beim Entfernen eines Self-Hosts: die Eintragung bleibt liegen und
 * wird von keinem `ready` mehr berührt — es verbindet sich ja niemand mehr
 * dorthin. Sichtbar ist davon nichts, sie hält aber den Standplatz-Betrieb am
 * Leben (`DeviceKiosk`/`DeviceSichtschutz` fragen nur, OB es Eintragungen
 * gibt), und dieser Rechner hält seinen Schirm dafür wach.
 */
export function verwaisteDurchServer(
  eintragungen: readonly AbgleichEintragung[],
  serverIds: readonly string[],
): string[] {
  if (serverIds.length === 0) return [];
  const bekannt = new Set(serverIds);
  return eintragungen.filter((e) => !bekannt.has(e.serverId)).map((e) => e.deviceId);
}
