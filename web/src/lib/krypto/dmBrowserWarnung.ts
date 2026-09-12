/**
 * Ob der Browser-Warnhinweis ueber den Direktnachrichten steht — importfrei,
 * damit Nodes eingebauter Testlaeufer die Datei ohne Bundler prueft (s.
 * CLAUDE.md „Die Falle").
 *
 * Hintergrund ist die Aufhebung der Koexistenz-Regel (Spec §3, 2026-09-12):
 * auch ein Konto ganz ohne haltbares Geraet — reiner Browser-Tab — kann
 * senden und empfangen, Browser gegen Browser eingeschlossen. Die
 * Nachrichten liegen dann E2E-verschluesselt nur auf den Geraeten der
 * Beteiligten; der Browserspeicher ist der fluechtigste davon (Browser
 * raeumen ihn bei Speicherdruck ab, Nutzer leeren Website-Daten). Deshalb
 * dieser Hinweis — er ersetzt die fruehere Wand als Datentransport-Schutz.
 *
 * Drei Eingaben, alle mit derselben Drei-Zustand-Logik wie die alte Wand
 * (`undefined` = Auskunft noch unterwegs => NICHT zeigen: ein kurz
 * aufblitzender Warnhinweis bei jemandem, der laengst gesichert ist, waere
 * schlimmer als ein spaet erscheinender richtiger):
 *
 *  * `appKontext` — in der App (Electron/Android) laeuft der Hinweis ins
 *    Leere: Dort ist das Speicherprofil dauerhaft, das Risiko besteht nicht.
 *  * `haltbaresGeraet` — hat das KONTO mindestens ein dauerhaftes Geraet
 *    (App) oder einen gekoppelten Browser, haelt irgendwo eine zweite Kopie
 *    (jede DM geht an ALLE Geraete beider Konten). Erst ein Konto ganz ohne
 *    solches Geraet ist der Warnfall.
 *  * `laufwerkVerbunden` — eine verbundene Sicherung (Google Drive/
 *    Nextcloud) spiegelt den verschluesselten Verlauf aus; mit ihr ist das
 *    Risiko gebunden und der Hinweis falsch.
 */
export function browserWarnungNoetig(
  appKontext: boolean,
  haltbaresGeraet: boolean | undefined,
  laufwerkVerbunden: boolean | undefined
): boolean {
  if (appKontext) return false;
  if (haltbaresGeraet === undefined || laufwerkVerbunden === undefined) return false;
  return !haltbaresGeraet && !laufwerkVerbunden;
}
