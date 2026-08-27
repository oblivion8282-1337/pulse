/**
 * Die vier mobilen Bereiche und die Rechnung, die aus einem Pfad ableitet,
 * welcher davon aktiv ist und ob gerade ein Detail-Bildschirm offen liegt.
 *
 * **Warum das ein eigenes Modul ist und keine Funktion im Layout:** es ist die
 * einzige Stelle, die entscheidet, ob die Bereichs-Leiste sichtbar sein darf.
 * Diese Entscheidung faellt an vier Stellen (Leiste selbst, Tablet-Spalte,
 * Layout-Regel, Hervorhebung) und muss ueberall dieselbe sein.
 *
 * **Das Modul hat bewusst KEINEN Laufzeit-Import.** Es wird von
 * `web/test/tabs.test.ts` mit Nodes eingebautem Laeufer geprueft, und Node
 * loest die erweiterungslosen Importe der Web-Quellen (`from './nachbar'`)
 * nicht auf — ein einziger echter Import genuegt, und der Test laeuft nicht
 * mehr. Wer hier etwas gemeinsam nutzen will, bezahlt es mit der Testbarkeit.
 *
 * **Der Zustand „welcher Bereich, wie tief" wird nicht gespeichert.** Er steht
 * in der URL; das hier ist reine Rechnung darauf. Damit erledigen die
 * System-Zurueck-Geste und die Spruenge aus einer Benachrichtigung sich von
 * selbst, statt nachgebaut werden zu muessen.
 */

export type TabId = 'chats' | 'rooms' | 'friends' | 'me';

export interface Bereich {
  readonly id: TabId;
  /** Wurzel des Bereichs — zugleich das Ziel des Knopfes in der Leiste. */
  readonly href: string;
}

/** Die vier Bereiche in Anzeigereihenfolge (links nach rechts, oben nach unten). */
export const BEREICHE: readonly Bereich[] = [
  { id: 'chats', href: '/app/@me' },
  { id: 'rooms', href: '/app/rooms' },
  { id: 'friends', href: '/app/friends' },
  { id: 'me', href: '/app/me' }
];

/**
 * Alle Pfad-Wurzeln je Bereich, laengste zuerst geprueft.
 *
 * `/app/guilds/...`, `/app/discover` und `/app/server` gehoeren zu „Raeume",
 * obwohl sie nicht unter `/app/rooms` liegen: der Kanal-Chat ist die dritte Ebene des
 * Raeume-Bereichs, und Entdecken ist der Ausgang aus seinem Leerzustand. Wer
 * hier nur das erste Segment vergleicht, verliert im offenen Kanal die
 * Hervorhebung.
 */
const WURZELN: readonly (readonly [string, TabId])[] = [
  // `/app/@me` VOR `/app/me` — sonst genuegte die Segmentgrenze nicht, um die
  // beiden auseinanderzuhalten; sie unterscheiden sich nur im `@`.
  ['/app/@me', 'chats'],
  ['/app/rooms', 'rooms'],
  ['/app/guilds', 'rooms'],
  ['/app/discover', 'rooms'],
  // Der eigene Server gehoert zu „Raeume", obwohl er nicht darunter liegt:
  // beide Einstiege sitzen am Fuss der Community-Liste (Rail am Rechner,
  // `/app/rooms` auf Tablet und Handy). Ohne den Eintrag stuende beim
  // Oeffnen kein Bereich mehr hervorgehoben da.
  ['/app/server', 'rooms'],
  ['/app/friends', 'friends'],
  ['/app/me', 'me']
];

/**
 * Nachlaufende Schraegstriche abschneiden, damit `/app/rooms/` und
 * `/app/rooms` dieselbe Antwort geben. Ohne das waere `/app/rooms/` ein
 * Detail-Bildschirm mit leerem Namen und die Leiste verschwaende beim blossen
 * Anhaengen eines Strichs.
 */
function normalisieren(pfad: string): string {
  let p = pfad;
  while (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);
  return p;
}

/**
 * Prueft, ob `pfad` die Wurzel selbst ist oder darunter liegt — mit
 * Segmentgrenze. `/app/roomsomething` faengt zwar mit `/app/rooms` an, liegt
 * aber nicht darunter; ein reiner `startsWith`-Vergleich faellt genau dort um.
 */
function liegtUnter(pfad: string, wurzel: string): boolean {
  return pfad === wurzel || pfad.startsWith(wurzel + '/');
}

/** Der Bereich, zu dem dieser Pfad gehoert — oder `null` ausserhalb der vier. */
export function aktiverBereich(pfad: string): TabId | null {
  const p = normalisieren(pfad);
  for (const [wurzel, id] of WURZELN) {
    if (liegtUnter(p, wurzel)) return id;
  }
  return null;
}

/**
 * Liegt hinter der Bereichs-Wurzel noch mindestens ein Segment, ist ein
 * Detail-Bildschirm offen (ein Gespraech, eine Community, ein Kanal, eine
 * Einstellungs-Seite). Dort verschwindet die Bereichs-Leiste, damit der
 * Bildschirm dem Inhalt gehoert.
 *
 * Pfade ausserhalb der vier Bereiche sind nie ein Detail-Bildschirm — dort
 * gibt es keine Leiste, die sich verstecken koennte.
 */
export function istDetailScreen(pfad: string): boolean {
  const p = normalisieren(pfad);
  // Entdecken ist ein AUFGESCHOBENER Bildschirm ueber den Raeumen, kein
  // fuenfter Bereich: man kommt aus dem Raeume-Bereich dorthin und mit dem
  // Pfeil oben wieder zurueck. Ohne diese Zeile stuenden Zurueck-Pfeil UND
  // Bereichs-Leiste gleichzeitig da — das liest sich wie zwei Aussagen
  // darueber, wo man gerade ist.
  if (p === '/app/discover') return true;
  for (const [wurzel, _id] of WURZELN) {
    if (!liegtUnter(p, wurzel)) continue;
    // Die Community-Übersicht `/app/rooms/<guildId>` ist KEIN Detail-Screen:
    // Die Leiste bleibt — die offenen Kanäle darunter (`/app/guilds/…/…`)
    // sind es weiterhin.
    if (wurzel === '/app/rooms') return false;
    return p.length > wurzel.length;
  }
  return false;
}
