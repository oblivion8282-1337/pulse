/**
 * Fernsteuerung — **das Protokoll am Gerät**: wer wann wie lange übernommen hat.
 *
 * Bei einem beaufsichtigten Rechner ist die eigentliche Sicherheit, dass jemand
 * danebensitzt und zusieht. Bei einem Standplatz-Gerät fällt genau dieser Zeuge
 * weg. Der Entwurf
 * (`docs/plans/2026-08-14-fernsteuerung-unbeaufsichtigte-geraete.md`, §7) setzt
 * drei Dinge an seine Stelle; dieses Modul ist das erste davon — und
 * ausdrücklich **gleichberechtigt neben der Freigabe, nicht in einem
 * Untermenü**: wer ein Gerät dauerhaft freigibt, soll im selben Bild sehen, was
 * daraus geworden ist.
 *
 * **Am Gerät, nicht auf dem Server.** Aus demselben Grund wie die Freigabe
 * selbst (`standplatz.svelte.ts`): das Protokoll ist die Auskunft des Geräts an
 * seinen Besitzer. Ein serverseitiges Protokoll kommt mit dem Standplatz
 * (Stufe 2) dazu — es beantwortet die andere Frage („was geschah in dieser
 * Community"), ersetzt dieses hier aber nicht.
 *
 * **Was NICHT protokolliert wird:** was der Steuernde getan hat. Tastendrücke
 * oder Mausbewegungen mitzuschreiben wäre eine Überwachung des Steuernden statt
 * einer Auskunft über das Gerät — und es stünde im Widerspruch dazu, dass die
 * Fernsteuerung eine zugestandene Übernahme ist und keine geduldete.
 */

import { loadAll, saveAll } from '$lib/stream/persistence';

/** Ein Vorgang: eine Sitzung, von der Zustimmung bis zum Ende. */
export interface ProtokollEintrag {
  /** Sitzungskennung — zugleich die Zuordnung beim Abschluss. */
  id: string;
  /** Kennung des Steuernden. */
  von: string;
  /** Anzeigename zum Zeitpunkt der Übernahme. Namen ändern sich; das
   *  Protokoll soll sagen, wer es DAMALS war, und die Kennung daneben trägt
   *  die harte Zuordnung. */
  name: string;
  /** Beginn und Ende (ms seit Epoche). `ende === null` = läuft noch, oder der
   *  Client ist mitten in der Sitzung beendet worden. */
  beginn: number;
  ende: number | null;
  /** Kam die Zustimmung selbsttätig aus der Dauerfreigabe? Der Unterschied ist
   *  der ganze Punkt des Protokolls: eine Übernahme, der niemand zugesehen
   *  hat, muss sich von einer bestätigten unterscheiden lassen. */
  selbsttaetig: boolean;
}

/**
 * Wie viele Vorgänge aufgehoben werden.
 *
 * Genug, dass man ein paar Wochen zurückblicken kann, und wenig genug, dass der
 * Eintrag den Speicher nicht sprengt — der ganze Blob wird bei jedem Schreiben
 * neu serialisiert (`stream/persistence.ts`), ein unbegrenztes Protokoll machte
 * daraus mit der Zeit eine spürbare Bremse.
 */
const HOECHSTZAHL = 200;

const SPEICHER_SCHLUESSEL = 'remote.protokoll';

function istEintrag(roh: unknown): roh is ProtokollEintrag {
  if (!roh || typeof roh !== 'object') return false;
  const o = roh as Record<string, unknown>;
  return (
    typeof o.id === 'string' &&
    typeof o.von === 'string' &&
    typeof o.name === 'string' &&
    typeof o.beginn === 'number' &&
    (o.ende === null || typeof o.ende === 'number') &&
    typeof o.selbsttaetig === 'boolean'
  );
}

class RemoteProtokoll {
  /** Neueste zuerst — so wird es auch angezeigt. */
  eintraege = $state<ProtokollEintrag[]>([]);
  #geladen = false;

  /** Beim Start des Clients einmal rufen, zusammen mit der Freigabe. */
  async laden(vorgeladen?: Record<string, unknown>): Promise<void> {
    if (this.#geladen) return;
    this.#geladen = true;
    try {
      const alle = vorgeladen ?? (await loadAll());
      const roh = alle[SPEICHER_SCHLUESSEL];
      this.eintraege = Array.isArray(roh) ? roh.filter(istEintrag).slice(0, HOECHSTZAHL) : [];
    } catch {
      this.eintraege = [];
    }
    // **Offene Vorgänge schliessen.** Ein Eintrag ohne Ende stammt aus einer
    // Sitzung, die der Client nicht überlebt hat (Absturz, Stromausfall,
    // Neustart mitten in der Übernahme). Ihn offen stehen zu lassen sähe im
    // Protokoll aus wie eine laufende Fernsteuerung; ihn stillschweigend auf
    // „gerade eben beendet" zu setzen wäre gelogen. Er bekommt deshalb sein
    // Ende auf den Beginn — Dauer unbekannt, und genau das steht dann da.
    if (this.eintraege.some((e) => e.ende === null)) {
      this.eintraege = this.eintraege.map((e) => (e.ende === null ? { ...e, ende: e.beginn } : e));
      // Nicht abwarten: dieser Ruf liegt im Startpfad VOR dem
      // Verbindungsaufbau, und ein Schreibvorgang über den ganzen Blob wäre
      // dort spürbar. Der Stand im Speicher gilt sofort, und der nächste
      // Eintrag trägt die Korrektur ohnehin mit.
      void this.#sichern();
    }
  }

  /** Eine Übernahme beginnt. Doppelte Kennungen werden übergangen — der
   *  Aufrufer läuft über die Zustandsmaschine, aber ein Echo darf keinen
   *  zweiten Vorgang erzeugen. */
  async beginnen(
    id: string,
    von: string,
    name: string,
    selbsttaetig: boolean,
  ): Promise<void> {
    if (!id || this.eintraege.some((e) => e.id === id)) return;
    this.eintraege = [
      { id, von, name, beginn: Date.now(), ende: null, selbsttaetig },
      ...this.eintraege,
    ].slice(0, HOECHSTZAHL);
    await this.#sichern();
  }

  /** Eine Übernahme endet. Unbekannte oder längst geschlossene Kennungen sind
   *  kein Fehler: dieser Ruf hängt am einzigen Ausgang der Sitzung und läuft
   *  deshalb auch für Sitzungen, die es nie bis zur Zustimmung geschafft
   *  haben. */
  async beenden(id: string): Promise<void> {
    if (!id) return;
    const eintrag = this.eintraege.find((e) => e.id === id);
    if (!eintrag || eintrag.ende !== null) return;
    this.eintraege = this.eintraege.map((e) => (e.id === id ? { ...e, ende: Date.now() } : e));
    await this.#sichern();
  }

  /** Protokoll leeren — bewusst vorhanden: es ist die Auskunft des Geräts an
   *  seinen Besitzer, und der darf sie auch verwerfen. */
  async leeren(): Promise<void> {
    this.eintraege = [];
    await this.#sichern();
  }

  async #sichern(): Promise<void> {
    try {
      await saveAll({ [SPEICHER_SCHLUESSEL]: this.eintraege });
    } catch {
      // Wie überall in der Persistenz: der Stand im Speicher gilt weiter.
    }
  }
}

export const remoteProtokoll = new RemoteProtokoll();
