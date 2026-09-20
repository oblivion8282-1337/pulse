/**
 * Die privaten Gruppen dieses Kontos — der Klient-seitige Bestand.
 *
 * **Klein gehalten, und das mit Absicht.** Anders als bei DMs gibt es fuer
 * Gruppen weder ein Feld im `ready`-Rahmen noch ein Ereignis ueber die
 * Verbindung (nachgesehen: `routes/ws_ready.py` fuehrt kein Gruppenfeld,
 * `routes/private_gruppen.py` publiziert nichts). Der einzige Weg an den
 * Bestand ist `GET /gruppen`. Dieser Speicher ist deshalb ein ABBILD dieses
 * Aufrufs, keine eigene Wahrheit — er beantwortet drei Fragen:
 *
 *  1. „Ist diese Kanal-ID eine private Gruppe?" — der lokale Verlauf braucht
 *     das, um eine Gruppennachricht ueberhaupt ablegen zu duerfen
 *     (`verlauf/index.ts`), und die Gespraechsansicht, um den Server NICHT
 *     nach einem Verlauf zu fragen, den es dort nicht gibt.
 *  2. „Wie heisst sie, wer ist drin?" — fuer die Anzeige (Seitenleiste,
 *     Kopfzeile, Benachrichtigung).
 *  3. „Welche Kanaele muss diese Verbindung abonnieren?" — der
 *     `postfach_neu`-Weckruf faechert an die Abonnenten eines Kanals auf,
 *     also abonniert `ws/handlers/ready.ts` nach dem Fuellen JEDE Gruppe.
 *
 * `last_message_id` wird vom Klienten selbst nachgezogen (`ws/handlers/
 * chat.ts`), wenn eine entschluesselte Gruppennachricht ankommt: der Server
 * sieht sie nie und ruehrt die Spalte im verschluesselten Weg nicht an.
 *
 * **Was er ausdruecklich NICHT ist: die Quelle fuer die Mitgliederliste beim
 * SENDEN.** Der Sendeweg liest sie jedes Mal frisch (`gruppenApi.lesen`), weil
 * an ihr die Aussperrung haengt — s. `krypto/gruppe/sitzungswahl.ts`. Wer
 * das hier abkuerzt, macht aus einem Cache-Treffer ein Sicherheitsloch.
 */
import type { PrivateGruppe } from '$lib/api/gruppen';
import { compareSnowflakeId } from '$lib/utils/snowflake';

class PrivateGruppenStore {
  byId = $state<Record<string, PrivateGruppe>>({});

  /**
   * Loest genau einmal auf, sobald `seed()` zum ersten Mal lief.
   *
   * **Wofuer:** anders als DMs steht der Gruppen-Bestand nicht im
   * `ready`-Rahmen, sondern kommt ueber ein eigenes, NICHT abgewartetes
   * `GET /gruppen` (s. Modulkopf). Zwischen dem Rendern der Route und dieser
   * Antwort ist `istGruppe()` fuer jede echte Gruppe faelschlich `false` —
   * ein Direktlink/harter Reload auf eine Gruppen-ID faellt in diesem
   * Fenster in den DM-Zweig, der fuer eine Gruppen-ID scheitert
   * (`+page.svelte::switchTo`). Diese Promise gibt dem Aufrufer etwas zum
   * Abwarten, statt den leeren Anfangszustand fuer die Wahrheit zu halten.
   */
  #bereitAufloesen!: () => void;
  bereit: Promise<void> = new Promise((res) => {
    this.#bereitAufloesen = res;
  });

  /** Nach Aktualitaet, wie die DM-Liste: zuletzt beschriebene zuerst,
   *  danach nach Anlagezeit. */
  get list(): PrivateGruppe[] {
    return Object.values(this.byId).sort((a, b) => {
      const aKey = a.last_message_id ?? a.id;
      const bKey = b.last_message_id ?? b.id;
      return bKey.padStart(24, '0').localeCompare(aKey.padStart(24, '0'));
    });
  }

  /** Ersetzt den ganzen Bestand — die Antwort von `GET /gruppen` ist
   *  vollstaendig, ein Merge wuerde eine verlassene Gruppe stehen lassen.
   *  AUSNAHME (Bughunt Runde 6): die klientengefuehrte `last_message_id`
   *  (der Server sieht verschluesselte Nachrichten nie) bleibt stehen, wenn
   *  sie NEUER ist als der Server-Stand — sonst regrediert die Listen-
   *  sortierung bei jedem Ready/Seed, das mit einer Nachricht rennt. */
  seed(gruppen: PrivateGruppe[]): void {
    const next: Record<string, PrivateGruppe> = {};
    for (const g of gruppen) {
      const aktuell = this.byId[g.id];
      if (
        aktuell?.last_message_id &&
        (!g.last_message_id ||
          compareSnowflakeId(aktuell.last_message_id, g.last_message_id) > 0)
      ) {
        next[g.id] = { ...g, last_message_id: aktuell.last_message_id };
      } else {
        next[g.id] = g;
      }
    }
    this.byId = next;
    this.#bereitAufloesen();
  }

  /** Traegt eine einzelne Gruppe nach (Antwort einer Mutation). */
  upsert(gruppe: PrivateGruppe): void {
    this.byId = { ...this.byId, [gruppe.id]: gruppe };
  }

  entfernen(gruppeId: string): void {
    const next = { ...this.byId };
    delete next[gruppeId];
    this.byId = next;
  }

  istGruppe(kanalId: string): boolean {
    return kanalId in this.byId;
  }

  clear(): void {
    this.byId = {};
    // Neues Gate aufspannen: nach dem Leeren (Sign-Out/Account-Wechsel) muss
    // der nächste Seed wieder abwartbar sein — das alte Promise ist längst
    // aufgelöst, ein Aufrufer würde sonst den leeren Anfangszustand für die
    // Wahrheit halten (derselbe Bug, dem `bereit` ursprünglich galt).
    this.bereit = new Promise((res) => {
      this.#bereitAufloesen = res;
    });
  }
}

export const privateGruppen = new PrivateGruppenStore();
