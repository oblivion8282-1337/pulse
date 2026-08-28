/**
 * Waehlt aus, welche Zustellungs-IDs quittiert werden duerfen — importfrei,
 * damit Nodes eingebauter Testlaeufer die Auswahl-Logik direkt prueft, ohne
 * eine echte IndexedDB zu brauchen (`verlauf/db.ts` ist dort ausdruecklich
 * NICHT pruefbar, s. Kommentar dort / CLAUDE.md „Die Falle").
 *
 * FIX 1 des Bughunts vom 2026-08-28: die alte Fassung sammelte JEDE
 * entschluesselte Zustellungs-ID in eine gemeinsame Quittungsliste, bevor
 * ueberhaupt versucht wurde, sie lokal abzulegen — ein fehlgeschlagenes
 * Schreiben wurde trotzdem quittiert, und die Quittung loescht die einzige
 * Kopie auf dem Server. `quittierbareIds` verlangt jetzt den umgekehrten
 * Ablauf: erst ablegen (je Kanal-Gruppe unabhaengig), NUR bei Erfolg landen
 * die IDs dieser Gruppe im Ergebnis. Ein Fehlschlag in einer Gruppe
 * unterbricht die anderen Gruppen nicht.
 */

export type KanalGruppe = { nachrichten: unknown[]; ids: string[] };

/**
 * `ablegen` wird je Kanal-Gruppe genau einmal aufgerufen. Wirft sie, wird
 * `meldeFehler` mit dem Fehler aufgerufen und KEINE der IDs dieser Gruppe
 * landet im Ergebnis — die naechste Gruppe wird trotzdem noch versucht.
 */
export async function quittierbareIds(
  nachKanal: Map<string, KanalGruppe>,
  ablegen: (kanalId: string, nachrichten: unknown[]) => Promise<unknown>,
  meldeFehler: (err: unknown) => void
): Promise<string[]> {
  const quittierbar: string[] = [];
  for (const [kanalId, { nachrichten, ids }] of nachKanal) {
    try {
      await ablegen(kanalId, nachrichten);
      quittierbar.push(...ids);
    } catch (err) {
      meldeFehler(err);
    }
  }
  return quittierbar;
}
