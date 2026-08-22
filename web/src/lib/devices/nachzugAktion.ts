/**
 * Was passiert mit der lokalen Eintragung, wenn eine `device_changed`-Meldung
 * hereinkommt?
 *
 * Reine Entscheidung, importfrei für Nodes Testläufer — die eigentliche
 * Umsetzung (räumen/nachziehen/schreiben) bleibt in `anmeldung.svelte.ts`,
 * die Verzweigung liegt im WS-Handler (`ws/handlers/devices.ts`).
 *
 * **Die Pointe:** `device_changed` kommt bei JEDEM Gerätewechsel im selben
 * Kanal herein, nicht nur beim eigenen. Ohne `hatEintragung` als erste,
 * unbedingte Prüfung würde eine Meldung über ein FREMDES Gerät diesen
 * Rechner zu einem Gerät machen, das er nie eingetragen hat — genau die
 * Fehlerform, an der dieser Umbau schon dreimal gescheitert ist (Code, der
 * gut aussieht, aber im falschen Fall trotzdem greift).
 */
export type NachzugAktion = 'nichts' | 'vergessen' | 'nachziehen';

export function nachzugAktion(s: {
  /** Gibt es überhaupt eine lokale Eintragung mit dieser Gerätekennung? */
  hatEintragung: boolean;
  /** Trägt die Meldung `removed: true`? */
  entfernt: boolean;
  /**
   * Trägt die Meldung `moved: true`? Nur bei `entfernt: true` von Bedeutung —
   * markiert die Abmeldung an den ALTEN Standplatz beim Umstellen, die von
   * einem echten Löschen sonst nicht unterscheidbar wäre (Prüfbefund K-1,
   * 2026-08-20). Ein Umzug führt zu `'nichts'`: die direkt danach eintreffende
   * Änderungsmeldung mit dem neuen Standplatz erledigt das Nachziehen selbst.
   */
  umzug: boolean;
  /** Stimmen Community UND Name der Meldung schon mit der Eintragung überein? */
  unveraendert: boolean;
}): NachzugAktion {
  if (!s.hatEintragung) return 'nichts';
  if (s.entfernt) return s.umzug ? 'nichts' : 'vergessen';
  return s.unveraendert ? 'nichts' : 'nachziehen';
}

/** Eine `device_changed`-Meldung, reduziert auf das, was die Entscheidung
 *  braucht — importfrei wie der Rest dieser Datei. */
export interface DeviceChangedMeldung {
  deviceId: string;
  guildId: string;
  name: string;
  entfernt: boolean;
  umzug: boolean;
}

/** Was der Rechner bereits über seine eigenen Eintragungen weiss — reduziert
 *  auf das, was der Abgleich braucht. */
export interface LokaleEintragung {
  deviceId: string;
  guildId: string;
  name: string;
}

/**
 * Die volle Entscheidung, wie sie am Aufrufort (`ws/handlers/devices.ts`)
 * gebraucht wird: eine Meldung gegen die aktuell gemerkten Eintragungen
 * abgleichen und daraus die Aktion ableiten. Herausgezogen aus dem WS-Handler,
 * damit die reale Abfolge zweier Meldungen (Abmeldung mit `umzug`, gefolgt von
 * der Änderungsmeldung mit dem neuen Standplatz) ohne Browser durchspielbar
 * ist — der Handler selbst ist es nicht: er hängt an `$state`-Runes und einer
 * echten WS-Verbindung.
 */
export function nachzugFuer(
  meldung: DeviceChangedMeldung,
  eintragungen: readonly LokaleEintragung[],
): NachzugAktion {
  const vorhanden = eintragungen.find((e) => e.deviceId === meldung.deviceId);
  return nachzugAktion({
    hatEintragung: vorhanden !== undefined,
    entfernt: meldung.entfernt,
    umzug: meldung.umzug,
    unveraendert:
      vorhanden !== undefined &&
      vorhanden.guildId === meldung.guildId &&
      vorhanden.name === meldung.name,
  });
}
