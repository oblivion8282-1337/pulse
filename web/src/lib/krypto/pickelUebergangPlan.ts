/**
 * Die reine Rechnung des Pickle-Uebergangs: welche Marke gilt, welche
 * Eintraege der Identitaets-Datenbank ueberhaupt ein Pickle tragen, und wie
 * ihre neuen Werte aussehen.
 *
 * Importfrei, damit Nodes eingebauter Testlaeufer sie ohne Bundler prueft
 * (s. CLAUDE.md „Die Falle") — die IndexedDB- und WASM-Verkabelung steht
 * daneben in `pickelUebergang.ts`.
 *
 * **Warum es diesen Uebergang gibt** (Spec §3b, Absatz „Reihenfolge"): der
 * Pickle-Schluessel wurde bisher aus dem Ed25519-Anmeldeschluessel abgeleitet
 * (`account.svelte.ts::pickelschluesselDesGeraets`), und der ist auf `main`
 * ersatzlos geloescht. Faellt er weg, ohne dass die Ableitung vorher
 * umgestellt ist, laesst sich eingefrorener Olm-Zustand NIE WIEDER auftauen.
 * Solange beide Quellen nebeneinander existieren — also jetzt —, ist der
 * Wechsel verlustfrei moeglich; danach nicht mehr.
 *
 * **Alles oder nichts.** Diese Datei baut den vollstaendigen Plan und wirft,
 * sobald ein einziger Eintrag nicht zu deuten ist. Der Aufrufer schreibt
 * erst, wenn der Plan vollstaendig zurueckgekommen ist. Ein Teil-Uebergang
 * waere schlimmer als gar keiner: die Marke stuende auf „neu", ein Teil des
 * Zustands laege noch unter dem alten Schluessel, und dem Eintrag sieht
 * niemand an, mit welchem Schluessel er eingefroren wurde.
 */

/** Die eine gueltige Marke. Steht sie im Speicher, gilt der Pickle-Schluessel
 *  aus dem krypto-eigenen Geheimnis; fehlt sie, der aus dem
 *  Anmeldeschluessel. Ein dritter Wert ist kein Zustand, sondern ein Fehler
 *  — s. `markeDeuten`. */
export const MARKE_KRYPTOGEHEIMNIS = 'kryptogeheimnis-v1';

/** Die vier Familien eingefrorenen Zustands. Sie haengen ALLE am selben
 *  Pickle-Schluessel (`sitzungen.ts`, `gruppe/gruppenSitzungen.ts`) und
 *  muessen deshalb gemeinsam wandern — eine zurueckgelassene Familie waere
 *  nach dem Markenwechsel unlesbar. */
export type Pickleart = 'konto' | 'sitzung' | 'gruppensitzung' | 'gruppenempfang';

/** Ein Eintrag der Identitaets-Datenbank, so wie er gelesen wurde. */
export type Speichereintrag = { schluessel: string; wert: unknown };

/** Was unter einem Schluessel kuenftig stehen soll. */
export type Umschreibung = { schluessel: string; wert: unknown };

/** Signatur des Umfrierers, den `pickelUebergang.ts` mitbringt: einen mit dem
 *  ALTEN Schluessel eingefrorenen Pickle mit dem NEUEN wieder einfrieren. Als
 *  Parameter statt als Import, weil er die WASM-Klassen braucht und diese
 *  Datei importfrei bleibt. */
export type Umfrierer = (art: Pickleart, gefroren: string) => string;

/**
 * Deutet die gespeicherte Marke.
 *
 * **Kein Raten.** Ein unbekannter Wert bedeutet nicht „vermutlich alt",
 * sondern „dieser Speicher stammt nicht von einer Fassung, die wir kennen".
 * Beide Schluessel auszuprobieren waere hier die teuerste denkbare
 * Bequemlichkeit: wer falsch raet und danach neu einfriert, hat den Zustand
 * nicht beschaedigt, sondern verloren.
 */
export function markeDeuten(marke: unknown): 'offen' | 'schon_umgestellt' {
  if (marke === undefined || marke === null) return 'offen';
  if (marke === MARKE_KRYPTOGEHEIMNIS) return 'schon_umgestellt';
  // Der Wert selbst gehoert NICHT in die Meldung: er stammt aus dem
  // Speicher, und diese Meldung landet in Log und Fehlerberichten.
  throw new Error('PICKELMARKE_UNBEKANNT');
}

/** Welche Pickle-Familie unter diesem Schluessel liegt — `null` fuer alles
 *  andere in der Identitaets-Datenbank (Anmeldeschluessel, Zertifikat,
 *  Profil-Aussage, Rueckfallschluessel, das neue Geheimnis, die Kennung).
 *  Die Schluesselnamen stehen kanonisch bei ihren Besitzern; hier ist die
 *  einzige Stelle, die sie zusammen liest. */
export function pickleartVon(schluessel: string): Pickleart | null {
  if (schluessel === 'pulse.krypto-account') return 'konto';
  if (schluessel.startsWith('pulse.krypto-sitzung.')) return 'sitzung';
  if (schluessel.startsWith('pulse.krypto-gruppensitzung.')) return 'gruppensitzung';
  if (schluessel.startsWith('pulse.krypto-gruppenempfang.')) return 'gruppenempfang';
  return null;
}

/** Die ausgehende Gruppensitzung liegt als OBJEKT im Speicher — Pickle plus
 *  Buchhaltung (`gruppe/gruppenSitzungen.ts`: `sitzungId`, `mitglieder`,
 *  `beliefert`, `nachrichten`, `angelegtAm`). Nur das Feld `gefroren` ist
 *  Pickle; der Rest muss unveraendert stehen bleiben. */
function istGefrorenerStand(wert: unknown): wert is { gefroren: string } {
  return (
    typeof wert === 'object' &&
    wert !== null &&
    typeof (wert as { gefroren?: unknown }).gefroren === 'string'
  );
}

/**
 * Baut den vollstaendigen Umschreibe-Plan aus allen gelesenen Eintraegen.
 *
 * Eintraege ohne Pickle kommen gar nicht erst vor — sie durch den Umfrierer
 * zu schicken wuerde sie zerstoeren (der Rueckfallschluessel ist blanker
 * Base64-Text, das Geheimnis selbst ein `CryptoKey`).
 *
 * Wirft bei einem Eintrag, dessen Gestalt nicht passt. Ihn zu ueberspringen
 * waere die stille Variante desselben Verlusts: nach dem Markenwechsel laege
 * er unter einem Schluessel, den niemand mehr hat.
 */
export function umschreibenPlanen(
  eintraege: Speichereintrag[],
  umfrieren: Umfrierer
): Umschreibung[] {
  const plan: Umschreibung[] = [];
  for (const { schluessel, wert } of eintraege) {
    const art = pickleartVon(schluessel);
    if (!art) continue;

    if (art === 'gruppensitzung') {
      if (!istGefrorenerStand(wert)) throw new Error(`PICKLE_UNERWARTETE_GESTALT:${art}`);
      plan.push({ schluessel, wert: { ...wert, gefroren: umfrieren(art, wert.gefroren) } });
      continue;
    }

    if (typeof wert !== 'string') throw new Error(`PICKLE_UNERWARTETE_GESTALT:${art}`);
    plan.push({ schluessel, wert: umfrieren(art, wert) });
  }
  return plan;
}
