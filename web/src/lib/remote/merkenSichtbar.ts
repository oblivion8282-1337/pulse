/**
 * Zeigt der Zustimmungsdialog den Haken „auch künftig ohne Rückfrage"?
 *
 * Der Haken schreibt auf die Server-Freigabeliste EINES eingetragenen
 * Standplatz-Geräts (`RemoteConsentDialog.svelte`). Ohne eine lokale
 * Eintragung dieses Rechners auf dem gerade dispatchenden Server ist dieser
 * Rechner gar kein Standplatz-Gerät — es gibt keine Liste, in die der Haken
 * schreiben könnte, und ihn trotzdem anzuzeigen wäre ein Versprechen ins
 * Leere.
 *
 * Importfrei, damit Nodes eingebauter Testläufer sie direkt laden kann
 * (Muster wie `devices/reiterSichtbar.ts`).
 */
export function merkenSichtbar(s: { desktop: boolean; hatEintragung: boolean }): boolean {
  return s.desktop && s.hatEintragung;
}
