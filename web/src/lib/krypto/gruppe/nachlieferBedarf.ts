/**
 * Muss ueberhaupt etwas nachgeliefert werden — und wenn ja, fuer WESSEN
 * Geraete? Die Rechnung, die vor `POST /keys/claim` laeuft.
 *
 * **Warum sie existiert.** `kanalSchluesselNachliefern` rief `claim` fuer
 * ALLE Mitglieder, bevor feststand, ob ueberhaupt etwas offen ist — und
 * `claim` VERBRAUCHT je fremdem Geraet einen Einmalschluessel
 * (`routes/schluessel_abholen.py`). Ein Kanalwechsel kostete das Gegenueber
 * damit Vorrat, meist um dann festzustellen, dass alle Geraete den
 * Schluessel laengst haben. Die Antwort steht aber schon in der reinen
 * GERAETELISTE, und die gibt `POST /keys/geraeteliste` ohne Verbrauch her.
 *
 * **Importfrei bis auf `./sitzungswahl.ts`**, das selbst importfrei ist und
 * mit Dateiendung eingebunden wird — damit Nodes eingebauter Testlaeufer
 * diese Rechnung ohne Bundler pruefen kann (s. CLAUDE.md „Die Falle").
 *
 * **Die Wechsel-Entscheidung wird NICHT nachgebaut**, sondern von
 * `wechselgrund` geholt. Zwei Fassungen derselben Regel liefen sonst
 * auseinander, und die falsche waere hier die, die einen Ausgeschiedenen
 * weiterlesen liesse.
 */
import { wechselgrund } from './sitzungswahl.ts';
import type { Gruppenstand, Wechselgrenzen, Wechselgrund } from './sitzungswahl.ts';

/** Antwort von `POST /keys/geraeteliste`: Geraete-Kennungen je Konto. */
export type Geraeteliste = Record<string, string[]>;

export type Nachlieferbedarf = {
  /** Konten, deren Buendel geholt werden muessen. **Leer heisst: kein
   *  `claim`.** */
  konten: string[];
  /** Warum eine neue Sitzung noetig waere — `null`, wenn die vorhandene
   *  weiterlaeuft. Nur zur Nachvollziehbarkeit; die Wahl selbst trifft
   *  weiterhin `sitzungWaehlen`. */
  grund: Wechselgrund | null;
};

/** Die Zielgeraete EINES Kontos — ohne das eigene aktuelle Geraet, genau wie
 *  `gruppengeraeteBerechnen` es spaeter aus dem `claim`-Ergebnis rechnet. */
function zielgeraete(
  liste: Geraeteliste,
  userId: string,
  eigeneUserId: string,
  eigeneKennung: string
): string[] {
  const alle = liste[userId] ?? [];
  if (userId !== eigeneUserId) return alle;
  return alle.filter((pubkey) => pubkey !== eigeneKennung);
}

/**
 * Was vor der Nachlieferung zu holen ist.
 *
 * Zwei Faelle, und sie unterscheiden sich in der Menge:
 *
 * * **Eine neue Sitzung ist faellig** (`wechselgrund !== null`, auch beim
 *   allerersten Mal): jedes Zielgeraet braucht sie, also jedes Konto, das
 *   ueberhaupt eines hat.
 * * **Die vorhandene laeuft weiter**: nur die Konten mit mindestens einem
 *   noch nicht belieferten Geraet. Sind es keine, ist nichts zu tun — und
 *   genau dann unterbleibt der `claim`.
 */
export function nachlieferBedarf<S>(
  vorhanden: Gruppenstand<S> | null,
  mitgliederIds: string[],
  geraeteJeKonto: Geraeteliste,
  eigeneUserId: string,
  eigeneKennung: string,
  jetzt: number,
  grenzen?: Wechselgrenzen
): Nachlieferbedarf {
  const grund = wechselgrund(vorhanden, mitgliederIds, jetzt, grenzen);
  const hatGeraet = (userId: string) =>
    zielgeraete(geraeteJeKonto, userId, eigeneUserId, eigeneKennung).length > 0;

  if (grund !== null || vorhanden === null) {
    return { konten: mitgliederIds.filter(hatGeraet), grund };
  }

  const beliefert = new Set(vorhanden.beliefert);
  const konten = mitgliederIds.filter((userId) =>
    zielgeraete(geraeteJeKonto, userId, eigeneUserId, eigeneKennung).some(
      (pubkey) => !beliefert.has(pubkey)
    )
  );
  return { konten, grund: null };
}
