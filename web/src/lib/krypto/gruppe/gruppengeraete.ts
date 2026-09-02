/**
 * Welche Geraete eine Gruppennachricht erreichen muss — importfrei, damit
 * Nodes eingebauter Testlaeufer die Rechnung ohne Bundler prueft (s.
 * CLAUDE.md „Die Falle"). Gegenstueck zu `../empfaengerGeraete.ts`, das
 * dasselbe fuer eine DM tut.
 *
 * **Der Unterschied zur DM ist die Koexistenz-Regel — sie faellt hier weg.**
 * Bei einer DM wird nur verschluesselt, wenn BEIDE Konten ein dauerhaftes
 * Geraet haben; sonst laeuft der Klartext-Weg weiter (Spec §3). Fuer eine
 * private Gruppe gibt es diesen Weg nicht: sie ist von Geburt an
 * verschluesselt (Spec §9). Eine Regel „ohne dauerhaftes Geraet keine
 * Verschluesselung" hiesse hier deshalb nicht „unverschluesselt", sondern
 * „gar nicht" — und zwar fuer ALLE Mitglieder, wegen eines einzigen.
 *
 * Die Spec loest das an einer anderen Stelle: „Teilnahme setzt ein App-Geraet
 * voraus — wer nur im Browser sitzt, wird beim HINZUFUEGEN mit Begruendung
 * abgelehnt." **Diese Pruefung ist nicht gebaut** (weder in
 * `routes/private_gruppen.py` noch im Klienten), und sie gehoert an den
 * Hinzufuegen-Schritt, nicht hierher: hier wuerde sie nur still Empfaenger
 * verschlucken. Solange sie fehlt, bekommt jedes veroeffentlichte Geraet den
 * Schluessel — auch ein Browser. Der liest dann mit, solange er offen ist,
 * und verliert seinen Verlauf danach.
 */

/** Wire-Form eines Buendel-Eintrags aus `POST /keys/claim` — strukturgleich
 *  zu `GeraeteBuendelEintrag` in `../empfaengerGeraete.ts`; beide sind
 *  importfrei gehalten und deshalb zwei benannte Typen statt eines. */
export type GruppenBuendelEintrag = {
  device_pubkey: string;
  curve25519: string;
  einmalschluessel: string | null;
  rueckfallschluessel: string | null;
  dauerhaft?: boolean;
};

export type Gruppenzielgeraet = { userId: string; geraet: GruppenBuendelEintrag };

/**
 * Alle Geraete aller Mitglieder — ohne das EIGENE AKTUELLE Geraet (es hat
 * den Klartext schon, und eine Olm-Sitzung mit sich selbst gibt es nicht).
 * Die eigenen ANDEREN Geraete gehoeren dazu, sonst sieht der eigene Desktop
 * nie, was vom Handy in die Gruppe geschrieben wurde.
 *
 * Die Reihenfolge folgt `mitgliederIds` — sie kommt aus `GET /gruppen/{id}`
 * und ist damit fuer alle Sender dieselbe. Das macht die Ausgabe
 * vergleichbar, ohne dass irgendetwas davon abhinge.
 *
 * Ein Mitglied ohne jedes veroeffentlichte Geraet liefert schlicht keine
 * Eintraege. Das ist kein Fehler und darf die Sendung nicht aufhalten — es
 * heisst nur, dass diese Person die Nachricht (noch) nicht bekommt, so wie
 * jemand, dessen Geraet gerade abgemeldet ist.
 */
export function gruppengeraeteBerechnen(
  buendelJeKonto: Record<string, GruppenBuendelEintrag[]>,
  mitgliederIds: string[],
  eigeneUserId: string,
  eigenerGeraetePubkey: string
): Gruppenzielgeraet[] {
  const ziel: Gruppenzielgeraet[] = [];
  for (const userId of mitgliederIds) {
    for (const geraet of buendelJeKonto[userId] ?? []) {
      if (userId === eigeneUserId && geraet.device_pubkey === eigenerGeraetePubkey) continue;
      ziel.push({ userId, geraet });
    }
  }
  return ziel;
}

/** Teilt eine Liste in Bloecke fester Groesse. Eine leere Liste ergibt keine
 *  Bloecke (nicht einen leeren) — sonst entstuende eine Anfrage ohne Inhalt,
 *  die der Server ablehnt. */
export function inBloecke<T>(werte: T[], groesse: number): T[][] {
  const bloecke: T[][] = [];
  for (let i = 0; i < werte.length; i += groesse) {
    bloecke.push(werte.slice(i, i + groesse));
  }
  return bloecke;
}

/**
 * Teilt eine Empfaengerliste in Bloecke — `POST /postfach` deckelt
 * `empfaenger` je Nutzlast bei 64 (`PostfachNutzlastIn`, `max_length=64`).
 *
 * **Die Grenze zaehlt GERAETE, nicht Mitglieder.** Eine Gruppe darf bis zu
 * `private_group_max_members` (Vorgabe 50) Mitglieder haben, jedes Konto bis
 * zu `schluessel_max_buendel_je_konto` (Vorgabe 20) Geraete — 64 sind also
 * durchaus zu wenig. Der Megolm-Geheimtext bleibt derselbe, es entstehen nur
 * mehrere Nutzlast-Zeilen mit identischem `daten`; das ist immer noch eine
 * Kopie je 64 Geraete statt einer je Geraet.
 */
export function inEmpfaengerBloecke(pubkeys: string[], groesse = 64): string[][] {
  return inBloecke(pubkeys, groesse);
}

/**
 * Hoechstzahl Umschlaege je `POST /postfach`.
 *
 * Der Server deckelt bei `postfach_max_nutzlasten_je_anfrage` (Vorgabe 100)
 * und antwortet sonst mit 400 `zu_viele_nutzlasten` — die GANZE Anfrage
 * faellt dann, nicht der ueberzaehlige Teil. Eine Verteilrunde erzeugt einen
 * Umschlag je Geraet: schon eine Gruppe mit 35 Mitgliedern zu je drei
 * Geraeten reisst die Grenze, und zwar ausgerechnet bei einem
 * Schluesselwechsel — dem Moment, in dem gerade jemand hinausgeworfen wurde.
 *
 * 90 statt 100, damit ein spaeter dazukommender Umschlag (etwa fuer Anhaenge)
 * nicht sofort wieder anstoesst.
 */
export const MAX_UMSCHLAEGE_JE_ANFRAGE = 90;

/** Ein einzuliefernder Umschlag — strukturgleich zu `PostfachNutzlast` in
 *  `api/postfach.ts`; hier noch einmal benannt, weil diese Datei importfrei
 *  bleibt. */
export type GruppenUmschlag = {
  art: number;
  daten: string;
  empfaenger: string[];
  archiv: boolean;
};

/**
 * Baut aus den Empfaenger-Bloecken (`inEmpfaengerBloecke`) die
 * einzuliefernden Umschlaege — mit der Archiv-Marke an **genau einem**, dem
 * ersten.
 *
 * Die Blockteilung ist eine Empfaenger-Teilung, kein Inhalt: ab 65
 * Zielgeraeten entstehen mehrere Nutzlasten mit bitgleichem `daten`. Traegt
 * jede von ihnen `archiv: true`, legt der Server dieselbe Nachricht mehrfach
 * im Kanal-Ordner ab — jede unter einem anderen Dateinamen (der Name ist die
 * Nutzlast-ID), also ohne dass irgendetwas sie noch zusammenfuehren koennte.
 * Genau ein Umschlag genuegt: welcher, ist gleichgueltig — sie sind
 * inhaltlich identisch.
 */
export function gruppenUmschlaegeBauen(
  art: number,
  daten: string,
  bloecke: readonly (readonly string[])[]
): GruppenUmschlag[] {
  return bloecke.map((block, i) => ({
    art,
    daten,
    empfaenger: [...block],
    archiv: i === 0
  }));
}
