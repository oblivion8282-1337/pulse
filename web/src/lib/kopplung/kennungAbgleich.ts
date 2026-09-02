/**
 * Welche Positionen beim Fortsetzen als „schon da" gelten — reine Rechnung,
 * ausgelagert aus `senden.ts` fuer die Node-Pruefbarkeit (s. CLAUDE.md „Die
 * Falle": `senden.ts` importiert `api/servers.svelte` und ist damit selbst
 * nicht direkt pruefbar).
 *
 * Der eigentliche Fund (Bughunt 2026-08-29, Befund 1): eine Position allein
 * an ihrer Nummer als „unveraendert" zu behandeln, uebersieht ein Stueck,
 * dessen Inhalt sich seit dem letzten Lauf geaendert hat (bearbeitete/
 * geloeschte Nachricht waehrend der bis zu 48-stuendigen Kopplungsfrist),
 * sobald die neue Einteilung zufaellig dieselbe Stueckzahl ergibt. Eine
 * Position zaehlt deshalb nur dann als vorhanden, wenn ihre lokal neu
 * berechnete Inhalts-Kennung mit der vom Server zurueckgegebenen
 * uebereinstimmt — beides kommt fertig berechnet herein, diese Funktion
 * kennt weder Kryptografie noch Netzwerk.
 */
export function vorhandeneNachKennungAbgleich(
  vorhandeneStuecke: readonly number[],
  serverKennungen: Readonly<Record<string, string>>,
  lokaleKennungen: ReadonlyMap<number, string>,
  gesamt: number
): number[] {
  const vorhanden: number[] = [];
  for (const folge of vorhandeneStuecke) {
    // Der Server koennte Positionen einer aelteren, groesseren Einteilung
    // melden — dieselbe Randbedingung wie in `fehlendeStuecke`.
    if (folge >= gesamt) continue;
    const serverKennung = serverKennungen[String(folge)];
    if (!serverKennung) continue;
    if (lokaleKennungen.get(folge) === serverKennung) vorhanden.push(folge);
  }
  return vorhanden;
}
