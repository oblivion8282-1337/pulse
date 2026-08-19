/**
 * Die reine Rechnung hinter „muss ich melden, auf welchen Plätzen dieser
 * Rechner als Gerät sendet?"
 *
 * **Dieses Modul importiert bewusst nichts** — dann läuft es unverändert in
 * Nodes eingebautem Testläufer (`pnpm test:unit`), der erweiterungslose
 * Laufzeit-Importe nicht auflöst. Muster wie
 * `src/lib/remote/zeigerbildPruefung.ts`.
 *
 * Zwei Dinge, die hier zusammengehören und vorher auseinanderlagen
 * (Bughunt 2026-08-19):
 *
 * 1. **Je Server ein eigener Merker.** Vorher gab es EINEN für alle
 *    Eintragungen. Wer in der Cloud UND auf einem Self-Host eingetragen ist,
 *    versorgte damit nur den ersten Server: nach dessen Meldung galt der
 *    Schlüssel als gemeldet, und der zweite fiel durch dieselbe Prüfung.
 * 2. **Ein Abriss entwertet den Merker.** Der Merker lebt im Klienten, der
 *    Serverzustand nicht: `device_withdraw` leert die Platzmenge beim
 *    Offlinegehen. Nach dem Wiederverbinden meldete sich das Gerät nur neu an
 *    (`device_announce`), nie erneut mit seinen Plätzen — es sendete, galt
 *    serverseitig aber als plattlos, und sein Hauptbildschirm wurde einem
 *    Steuernden erneut als frei angeboten. Deshalb ruft die Anmeldung
 *    [`nachAbriss`], und zwar an genau der Stelle, an der sie sich neu
 *    anmeldet — sonst laufen beide Wege auseinander.
 *
 * Der Merker selbst bleibt nötig: ohne ihn liefe bei jeder Zustandsänderung
 * eines Stroms (Bitrate, Zuschauerzahl) eine Nachricht hinaus.
 */

/** Zuletzt gemeldeter Platz-Schlüssel je Server. */
export type MeldeStand = Readonly<Record<string, string>>;

/** Die Plätze zu einem vergleichbaren Schlüssel eindampfen. */
export function platzSchluessel(slots: readonly number[]): string {
  return [...slots].sort((a, b) => a - b).join(',');
}

/** Ist für diesen Server eine Meldung fällig? */
export function meldungFaellig(stand: MeldeStand, serverId: string, schluessel: string): boolean {
  return stand[serverId] !== schluessel;
}

/** Nach erfolgreicher Meldung. Gibt einen NEUEN Stand zurück (die Oberfläche
 *  hängt an der Zuweisung, nicht an einer Mutation). */
export function nachMeldung(stand: MeldeStand, serverId: string, schluessel: string): MeldeStand {
  return { ...stand, [serverId]: schluessel };
}

/**
 * Nach einem Verbindungsabriss bzw. vor einer Neuanmeldung: der Server hat die
 * Platzmenge dieses Geräts vergessen, unser Merker darf es auch.
 *
 * **Immer ein NEUES Objekt, auch wenn nichts zu löschen war.** Der Aufrufer ist
 * ein `$state` (`platzMeldung.svelte.ts`), und Svelte 5 invalidiert bei
 * Zuweisung derselben Referenz nicht. Die frühere Abkürzung `if (!(serverId in
 * stand)) return stand;` traf genau den Fall, den diese Reparatur zusagt: war
 * ein Server beim letzten Durchgang unversorgt geblieben (keine Verbindung),
 * stand er gar nicht im Merker — `vergessen()` war dann ein No-Op, der Effekt
 * lief nach der Neuanmeldung nicht erneut, und das Gerät blieb serverseitig
 * plattlos. Ein überzähliges Neuanlegen kostet einen Effekt-Durchgang, der
 * ohnehin nichts sendet, wenn nichts fällig ist.
 */
export function nachAbriss(stand: MeldeStand, serverId: string): MeldeStand {
  const rest: Record<string, string> = { ...stand };
  delete rest[serverId];
  return rest;
}

/**
 * Einen Durchgang über alle Eintragungen fahren und den neuen Stand
 * zurückgeben.
 *
 * `senden` meldet `false`, wenn die Nachricht NICHT hinausging (keine
 * Verbindung, Fehler beim Senden). Dann bleibt dieser Server ungemeldet — und
 * die übrigen werden trotzdem versorgt. Genau das ging vorher schief: beide
 * Abbrüche waren `return`, ein Server ohne Verbindung nahm damit alle
 * folgenden mit.
 */
export function meldungenAusfuehren(
  stand: MeldeStand,
  serverIds: readonly string[],
  schluessel: string,
  senden: (serverId: string) => boolean,
): MeldeStand {
  let neu = stand;
  for (const serverId of serverIds) {
    if (!meldungFaellig(neu, serverId, schluessel)) continue;
    if (!senden(serverId)) continue;
    neu = nachMeldung(neu, serverId, schluessel);
  }
  return neu;
}
