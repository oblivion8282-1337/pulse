/**
 * In welchem Zustand ist die Eintragung DIESES Rechners auf DIESEM Server?
 *
 * Der Standplatz-Reiter kannte bis zum 2026-08-21 nur zwei Fälle —
 * „eingetragen" und „nicht eingetragen" — und leitete sie allein daraus ab,
 * ob eine lokale Eintragung vorliegt. Der dritte Fall fiel damit auf den
 * ersten: eine Eintragung, zu der der Server keine Gerätezeile (mehr)
 * liefert, sah aus wie eine gesunde. Der Reiter zeigte dann das
 * Verwaltungs-Formular für ein Gerät, das niemand auflösen konnte — leeres,
 * ausgegrautes Kanalfeld, kein Hinweis, und das Eintragen-Formular blieb
 * verborgen. Von aussen: „ich kann nichts auswählen".
 *
 * Der vierte Fall ist das Laden selbst. Ohne ihn wäre jeder Reiter-Aufruf für
 * einen Wimpernschlag „verwaist", und der Hinweis blitzte bei jedem gesunden
 * Gerät auf.
 *
 * Importfrei für Nodes Testläufer.
 */

export type EintragungLage =
  /** Kein lokaler Eintrag — der Rechner kann eingetragen werden. */
  | 'keine'
  /** Eintrag da, Gerätezeile aufgelöst — verwalten. */
  | 'eingetragen'
  /** Eintrag da, Gerätezeile nachweislich nicht (mehr) zu haben. */
  | 'verwaist'
  /** Eintrag da, die Antwort steht noch aus. */
  | 'laedt';

export function eintragungLage(s: {
  /** Liegt für diesen Server überhaupt eine lokale Eintragung vor? */
  hatEintragung: boolean;
  /** Konnte die Gerätezeile aus dem Geräte-Store aufgelöst werden? */
  geraetGefunden: boolean;
  /** Steht die Communityliste dieses Servers (aus dem `ready`-Rahmen)? */
  communityListeGeladen: boolean;
  /** Ist die Community der Eintragung darin enthalten? */
  communityBekannt: boolean;
  /** Wurde die Geräteliste dieser Community schon vollständig abgerufen? */
  geraeteListeGeladen: boolean;
}): EintragungLage {
  if (!s.hatEintragung) return 'keine';
  if (s.geraetGefunden) return 'eingetragen';
  // **Die Community zuerst, und ohne die Geräteliste abzuwarten.** Steht die
  // Community nicht in der Liste, läuft der Geräte-Abruf in ein 403
  // (`require_member`) — und der markiert die Community bewusst NICHT als
  // geladen, damit ein Verbindungsabriss es erneut versuchen darf
  // (`store.svelte.ts::ensureLoaded`). Wer hier auf `geraeteListeGeladen`
  // wartete, bliebe deshalb für immer bei „lädt".
  if (s.communityListeGeladen && !s.communityBekannt) return 'verwaist';
  if (s.geraeteListeGeladen) return 'verwaist';
  return 'laedt';
}
