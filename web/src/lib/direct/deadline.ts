/**
 * Zeitbudget-Hilfe des Direktpfads — bewusst importfrei (node --test lädt
 * diese Datei direkt; connection.ts selbst zieht WebRTC-Protokoll-Importe).
 *
 * Zwei Nutzer (App-Hosting, 2026-10-03):
 *  - DirectConnection.open: Gesamtbudget für EINEN Verbindungsaufbau — ohne
 *    ihn stapeln sich Gathering-Deckel + Offer-Roundtrip + Channel-Deckel zu
 *    ~11+ s, die jeder Klick auf einen „online“-gemeldeten, aber toten
 *    App-Host verbrennt (Crash/Stromausfall: kein Abschied, das Telefonbuch
 *    lügt bis zu 300 s).
 *  - GatewayConnection.waitForReady(timeoutMs): der App-Start wird nach dem
 *    Deckel entlassen, statt auf einen schlafenden letzten aktiven Server zu
 *    warten.
 */

/** true = die Schritte sind abgeschlossen; false = die Deadline war schneller.
 *  Rejects der Schritte gehen DURCH (ein Fingerprint-Konflikt muss als
 *  solcher erkennbar bleiben, nicht als generischer Aufbau-Fehler). */
export function aufbauGedeckelt(schritte: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
  });
  const erfolg = schritte.then(() => {
    if (timer !== undefined) clearTimeout(timer);
    return true;
  });
  return Promise.race([erfolg, deadline]);
}

/** Geduldsfrist des Gateways für den Direkt-Dial eines VPS-Servers
 *  (2026-10-03): Steht die Abkürzung nicht in dieser Zeit, nimmt der Socket
 *  den normalen Weg über den Hostnamen — der Dial läuft weiter und deckt
 *  spätere Verbindungsaufbauten (Reconnect/Server-Wechsel). 1,5 s sind ein
 *  guter Kompromiss: ein funktionierender LAN-/WAN-Weg steht meist <1 s,
 *  alles darüber wäre reine Startverzögerung. */
export const VPS_DIAL_WARTE_MS = 1_500;
