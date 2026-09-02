/**
 * Merkt sich pro DM-Kanal, ob ein Gap-Fill-Overflow (`ws/gapFill.ts`,
 * `refetchOnOverflow`-Zweig) eine Luecke im lokalen Verlauf hinterlassen hat
 * — importfrei, damit Nodes Testlaeufer die Rechnung direkt prueft (s.
 * CLAUDE.md „Die Falle").
 *
 * WARUM "lokal hat Zeilen geliefert" NICHT reicht (Bughunt Fund 2):
 * ueberspringt der Overflow-Zweig eine grosse Luecke, legt er nur die NEUE,
 * juengste Serverseite lokal ab (`messages.setInitial` + `verlaufSpeichern`
 * in `gapFill.ts`) — der ALTE Bestand bis zur letzten bekannten ID vor dem
 * Sprung bleibt unangetastet in IndexedDB liegen. Danach existieren zwei je
 * FUER SICH lueckenlose Bereiche mit einem unbekannten Loch dazwischen. Eine
 * Cursor-Anfrage (`nachladen.ts::ladeAeltereSeite`), die genau in dieses
 * Loch faellt, findet lokal trotzdem Zeilen — den alten Bestand, der zufaellig
 * unterhalb der Cursor-Grenze liegt — und haelt das faelschlich fuer die
 * naechste zusammenhaengende Seite. Ohne diese Markierung ist das vom
 * echten Historie-Ende nicht zu unterscheiden.
 *
 * NUR fuer die laufende Session (In-Memory, kein IndexedDB-Store): ein
 * Tab-Reload verliert die Markierung. Deckt damit den Regelfall ab (Nutzer
 * scrollt in der laufenden Sitzung hoch, kurz nach einem Kanalwechsel-
 * Overflow) — eine ueber einen Reload hinweg haltbare Fassung braeuchte
 * einen eigenen IndexedDB-Store und damit eine `DB_VERSION`-Migration
 * (s. Kommentar dort, bewusst nicht Teil dieser Reparatur).
 */

export type Luecke = {
  /** Alles <= dieser ID ist der ALTE, fuer sich lueckenlose Bestand. */
  grenzeUnten: string;
  /** Alles >= dieser ID ist der NEUE, fuer sich lueckenlose Bestand. */
  grenzeOben: string;
};

const luecken = new Map<string, Luecke>();

/**
 * ID-Vergleich, dupliziert aus `utils/snowflake.ts::compareSnowflakeId` (wie
 * in `zusammenfuegen.ts` begruendet: dieses Modul darf nichts importieren).
 * Hier unproblematisch: die verglichenen IDs stammen ausschliesslich vom
 * Server (`ws/gapFill.ts`/`chatApi.listMessages`), also EIN einheitliches
 * Snowflake-Schema — "Laenge zuerst" ist dafuer korrekt (s. Begruendung in
 * `zusammenfuegen.ts`, wo genau das fuer gemischte ID-Schemata NICHT gilt).
 */
function vergleicheId(a: string, b: string): number {
  if (a.length !== b.length) return a.length - b.length;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Wird bei einem Gap-Fill-Overflow gerufen: `grenzeUnten` ist die letzte
 *  vor dem Sprung bekannte ID, `grenzeOben` die aelteste ID der neu
 *  abgelegten Seite. */
export function lueckeMarkieren(kanalId: string, grenzeUnten: string, grenzeOben: string): void {
  luecken.set(kanalId, { grenzeUnten, grenzeOben });
}

/** Faellt eine Nachlade-Anfrage mit Cursor `vor` in eine bekannte Luecke
 *  (oder darunter)? Nur dann darf `ladeAeltereSeite` einem lokalen Treffer
 *  nicht vertrauen. */
export function betrifftLuecke(kanalId: string, vor: string): boolean {
  const l = luecken.get(kanalId);
  if (!l) return false;
  return vergleicheId(vor, l.grenzeOben) <= 0;
}

/**
 * Nach einer Server-Antwort fuer eine Nachlade-Seite: schliesst die Luecke,
 * wenn die Antwort bis zur unteren Grenze (oder darunter) reicht, oder wenn
 * sie kuerzer als angefragt war (Historie-Ende — dann gibt es unterhalb
 * ohnehin nichts mehr, das die Luecke noch beträfe). Reicht sie nicht bis
 * zur unteren Grenze, wird nur die OBERE Grenze nachgezogen — sonst muesste
 * jede weitere Seite erneut die komplette (womoeglich sehr grosse) Luecke
 * serverseitig abfragen, statt sich Schritt fuer Schritt durchzuarbeiten.
 */
export function lueckeNachServerantwortAktualisieren(
  kanalId: string,
  aeltesteIdDerAntwort: string | undefined,
  antwortKuerzerAlsAngefragt: boolean
): void {
  const l = luecken.get(kanalId);
  if (!l) return;
  if (
    !aeltesteIdDerAntwort ||
    antwortKuerzerAlsAngefragt ||
    vergleicheId(aeltesteIdDerAntwort, l.grenzeUnten) <= 0
  ) {
    luecken.delete(kanalId);
    return;
  }
  luecken.set(kanalId, { ...l, grenzeOben: aeltesteIdDerAntwort });
}

/** Nur fuer Tests: setzt den gesamten Zustand zurueck (modulweiter Map). */
export function _lueckenZuruecksetzenFuerTest(): void {
  luecken.clear();
}
