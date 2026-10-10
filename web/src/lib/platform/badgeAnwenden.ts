/**
 * Die Zahl ans App-Icon legen — aber nur, wenn die Erlaubnis schon vorliegt.
 *
 * **Warum erst fragen, ob man darf.** `@capawesome/capacitor-badge` ruft in
 * `set`, `clear`, `increase` und `decrease` zuerst
 * `requestAuthorization(options: .badge)` (`BadgePlugin.swift`, 8.0.3). Steht
 * die Mitteilungs-Erlaubnis noch auf „nicht entschieden", ist das DER
 * System-Dialog, der auf iOS genau einmal erscheint. Unser Aufrufer hängt am
 * Ungelesen-Stand und läuft damit gleich beim ersten Start — der Dialog kam
 * also vor jeder Vorerklärung und fragte nur nach Plaketten (Bughunt
 * 2026-10-11, T5). Ein „ja" dort erteilt laut Apple allein `.badge` (nicht
 * gemessen): Firebase meldet danach trotzdem `granted`, die Vorerklärung für
 * Banner und Ton käme nie, Banner und Ton blieben aus. Ein „nein" ist
 * endgültig.
 *
 * Gefragt wird deshalb ausschliesslich über `fcm.ts::mitteilungenAnfragen`
 * (mit Vorerklärung, `.alert`/`.badge`/`.sound` zusammen). Bis dahin bleibt
 * das Icon leer — die Plakette ist eine Bequemlichkeit, die Erlaubnis nicht.
 *
 * `checkPermissions` fragt nur nach (`getNotificationSettings`), es öffnet
 * nie einen Dialog. Ist die Erlaubnis erteilt, kehrt das `requestAuthorization`
 * in `set` sofort und ohne Dialog zurück.
 *
 * Importfrei und damit prüfbar (s. die `pnpm test:unit`-Falle in CLAUDE.md);
 * das Plugin kommt als Argument herein.
 */

/** Schmaler Ausschnitt des Badge-Plugins (nur was hier gerufen wird). */
export interface BadgeSchnittstelle {
  checkPermissions(): Promise<{ display: string }>;
  set(options: { count: number }): Promise<void>;
  clear(): Promise<void>;
}

/**
 * Legt `anzahl` ans Icon, wenn die Erlaubnis vorliegt. `false` heisst: nichts
 * getan, weil (noch) nicht erlaubt. Fehler des Plugins reicht es durch.
 */
export async function badgeAnwenden(badge: BadgeSchnittstelle, anzahl: number): Promise<boolean> {
  const { display } = await badge.checkPermissions();
  if (display !== 'granted') return false;
  // 0 räumt das Badge ab — `set({count: 0})` lässt auf manchen iOS-Fassungen
  // eine leere Plakette stehen, `clear()` ist der dokumentierte Weg.
  if (anzahl > 0) {
    await badge.set({ count: anzahl });
  } else {
    await badge.clear();
  }
  return true;
}
