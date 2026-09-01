/**
 * Sorgt dafuer, dass eine Weckung, die WAEHREND eines laufenden Zyklus
 * eintrifft, nicht verlorengeht — importfrei, damit Nodes Testlaeufer die
 * Ablauf-Rechnung direkt prueft, ohne den WASM-/IndexedDB-Importkegel von
 * `empfangen.ts` zu brauchen (s. CLAUDE.md „Die Falle").
 *
 * **Der Befund** (`empfangen.ts::laufenderZyklus`): die erste Nachricht einer
 * neuen Megolm-Sitzung geht in ZWEI Zustellungen — erst der Verteilschluessel
 * (`gruppe/gruppenEinliefern.ts`), dann die Nachricht. Jede loest ihr eigenes
 * `postfach_neu`-Ereignis aus. Trifft das zweite ein, waehrend der Empfaenger
 * noch das erste abarbeitet, haengte sich der alte Code nur an den bereits
 * laufenden Zyklus an — der aber ausschliesslich holt, was er BEIM START
 * kannte. Die eigentliche Nachricht blieb liegen, bis ETWAS ANDERES ausloest
 * (Neuverbinden, `ready`).
 *
 * **Der Mechanismus: hoechstens ein laufender Zyklus, hoechstens ein
 * vorgemerkter Nachlauf.** Ein Aufruf waehrend eines laufenden Zyklus
 * markiert keinen dritten, vierten, ... Lauf — er haengt sich an den EINEN
 * bereits vorgemerkten Nachlauf an, falls schon einer vorgemerkt ist. Zehn
 * Weckungen waehrend eines Laufs fuehren damit zu genau EINEM weiteren
 * Durchlauf, nicht zu zehn (kein Dauerlauf, keine Warteschlange). Ohne
 * Weckung waehrend des Laufs entsteht kein Nachlauf.
 *
 * **Der Nachlauf laeuft NACH dem aktuellen Zyklus, nie gleichzeitig mit ihm**
 * — genau eine `aufgabe()`-Ausfuehrung ist zu jedem Zeitpunkt unterwegs. Das
 * ist Absicht, nicht nur Nebenwirkung der Web-Lock-Sperre, die `aufgabe`
 * selbst noch zusaetzlich nimmt (`mitKontosperre` in `empfangen.ts`): der
 * Zyklus mutiert ein einziges geladenes `Identitaet`-Objekt ueber alle
 * Zustellungen hinweg (s. `empfangen.ts`-Modulkopf) — zwei Zyklen, die
 * gleichzeitig auf demselben mutierbaren Zustand liefen, waeren genau der
 * Schaden, gegen den `laufenderZyklus` urspruenglich gebaut wurde.
 *
 * **Wer den Nachlauf-Aufruf bekommt, das Ergebnis des NACHLAUFS** — nicht das
 * des schon laufenden Zyklus. Eine Weckung waehrend des Laufs ist der Beweis,
 * dass etwas Neues zugestellt wurde; wer deswegen aufgerufen wurde, soll auch
 * sehen, was der Nachlauf tatsaechlich findet (`empfangen.ts` zeigt das
 * Ergebnis sofort an, s. `ws/handlers/chat.ts::postfachAbholenUndAnzeigen`).
 *
 * **Ein scheiternder Zyklus haelt den Nachlauf nicht auf.** Wirft `aufgabe`,
 * startet der vorgemerkte Nachlauf trotzdem — der Fehler des vorherigen
 * Laufs wird dabei verschluckt (er ist bereits an dessen eigenen Aufrufer
 * gegangen), nur der Nachlauf entscheidet ueber sein eigenes Ergebnis.
 */
export function mitNachlaufBeiWeckung<T>(aufgabe: () => Promise<T>): () => Promise<T> {
  let aktuellerLauf: Promise<T> | null = null;
  let vorgemerkterNachlauf: Promise<T> | null = null;

  function starten(): Promise<T> {
    const lauf = aufgabe();
    aktuellerLauf = lauf;
    const aufraeumen = (): void => {
      // Nur zuruecksetzen, wenn `lauf` noch immer der aktuelle ist — bis
      // dahin hat ggf. schon der Nachlauf `aktuellerLauf` uebernommen (s.
      // unten), und dessen Eintrag darf hier nicht ueberschrieben werden.
      if (aktuellerLauf === lauf) aktuellerLauf = null;
    };
    // `.then(aufraeumen, aufraeumen)` statt `.finally(...)`: `finally` gaebe
    // eine EIGENE, ungenutzte Promise zurueck, die bei einem Fehlschlag von
    // `lauf` ebenfalls ablehnt — ohne Abnehmer waere das eine unbehandelte
    // Ablehnung. `aufraeumen` wirft selbst nie, die Ruecklauf-Promise hier
    // loest deshalb so oder so auf; der eigentliche Fehler bleibt unveraendert
    // an `lauf` (dem zurueckgegebenen Wert) haengen und geht an dessen
    // Abnehmer.
    lauf.then(aufraeumen, aufraeumen);
    return lauf;
  }

  return function ausloesen(): Promise<T> {
    if (!aktuellerLauf) return starten();
    if (!vorgemerkterNachlauf) {
      vorgemerkterNachlauf = aktuellerLauf.then(
        () => {
          vorgemerkterNachlauf = null;
          return starten();
        },
        () => {
          vorgemerkterNachlauf = null;
          return starten();
        }
      );
    }
    return vorgemerkterNachlauf;
  };
}
