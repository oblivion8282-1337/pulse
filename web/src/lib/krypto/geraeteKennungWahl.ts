/**
 * Die reine Rechnung hinter der eigenen Geraetekennung — importfrei, damit
 * Nodes eingebauter Testlaeufer sie ohne Bundler prueft (s. CLAUDE.md „Die
 * Falle"). Die Verkabelung (IndexedDB, Zertifikatsspeicher) steht daneben in
 * `geraeteKennung.ts`.
 *
 * **Was die Kennung leisten muss** (nachgesehen an ihren Verwendungsstellen,
 * nicht angenommen): sie ist der Bezeichner, unter dem der Server dieses
 * Geraet fuehrt (`DeviceKeyBundle.device_pubkey`), sie adressiert Umschlaege
 * (`postfach`), sie steht im IndexedDB-Schluessel jeder Olm-Sitzung
 * (`sitzungsschluessel.ts`), und sie entscheidet beim Faechern, welches der
 * eigenen Geraete das aktuelle ist (`empfaengerGeraete.ts`,
 * `gruppe/gruppengeraete.ts`). Daraus folgen genau vier Anforderungen:
 * **stabil** ueber Neustarts, **Zeichenkette** (sie faehrt durch URLs, JSON
 * und Speicherschluessel), **vergleichbar per `===`**, und **identisch mit
 * dem, was der Server gespeichert hat**. Geheim muss sie nicht sein — sie
 * wird veroeffentlicht.
 *
 * **Deshalb braucht es KEIN eigenes Schluesselpaar.** Die Olm-Identitaet ist
 * bereits eines je Geraet, im Geraet erzeugt (Spec §3b) — als BEZEICHNER
 * genuegt jede stabile Zeichenkette, und ein zweites Paar waere ein zweites
 * Geheimnis ohne zusaetzliche Aussage. Was ein eigenes Geheimnis braucht,
 * ist der Pickle-Schluessel, und zwar aus einem anderen Grund: er wird
 * gebraucht, BEVOR der Olm-Account geoeffnet werden kann, kann also nicht aus
 * ihm stammen (s. `pickelUebergangPlan.ts`).
 *
 * **Warum die Kennung trotzdem nicht die Olm-Identitaet IST, noch nicht.**
 * Der Server nimmt sie inzwischen aus dem Anfrage-Rumpf entgegen und haelt
 * sie nur noch gegen das angemeldete Konto (`schluessel_nachweis.py`) — er
 * schriebe also auch einen anderen Wert an. Was dagegen steht, ist der
 * BESTAND: die veroeffentlichten Buendel (`DeviceKeyBundle.device_pubkey`)
 * und alle bestehenden Olm-Sitzungen haengen am alten Wert. Eine andere
 * Kennung waere deshalb kein Umzug, sondern ein zweites, leeres Geraet neben
 * dem eigenen. Uebernommen wird genau der alte Wert — nur eben aus einer
 * Quelle, die den Wegfall des Zertifikats ueberlebt.
 */

export type Kennungswahl = {
  kennung: string;
  /** Ob der gespeicherte Wert nachgezogen werden muss. */
  schreiben: boolean;
};

/**
 * Waehlt die Kennung dieses Geraets aus dem gespeicherten Wert und dem
 * Zertifikat.
 *
 * Solange es ein Zertifikat gibt, ist SEIN Wert massgeblich — der
 * gespeicherte ist eine Kopie davon, kein zweiter Wille. Faellt das
 * Zertifikat weg, traegt die Kopie weiter; das ist die Bruecke ueber den
 * Umbau.
 *
 * Wirft, wenn beides fehlt: eine leere Kennung waere kein Rueckfall, sondern
 * ein Umschlag an niemanden — und beim Faechern fiele das eigene Geraet nicht
 * mehr heraus.
 */
export function kennungWaehlen(
  gespeichert: string | undefined,
  ausZertifikat: string | undefined
): Kennungswahl {
  if (ausZertifikat) {
    return { kennung: ausZertifikat, schreiben: gespeichert !== ausZertifikat };
  }
  if (gespeichert) return { kennung: gespeichert, schreiben: false };
  throw new Error('KEINE_GERAETEKENNUNG');
}
