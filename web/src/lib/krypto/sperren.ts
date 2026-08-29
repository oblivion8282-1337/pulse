/**
 * Tab-uebergreifende Sperren fuer den Krypto-Zustand — importfrei, damit
 * Nodes eingebauter Testlaeufer sie ohne den WASM-/IndexedDB-Importkegel
 * prueft (s. CLAUDE.md „Die Falle").
 *
 * **Warum eine Modul-Variable hier NICHT genuegt** (Bughunt 2026-08-29): der
 * gesamte Krypto-Zustand — Konto-Pickle, Olm-Sitzungen, Gruppensitzungen —
 * liegt in IndexedDB, und die gehoert dem BROWSERPROFIL, nicht dem Tab. Jeder
 * Tab derselben Herkunft sieht denselben Speicher. Eine Warteschlange im
 * Modul-Scope entsteht dagegen je Tab neu; sie ordnet nur, was ohnehin in
 * einem einzigen JavaScript-Kontext laeuft, und ist gegen den Fall, um den es
 * hier geht, wirkungslos. Die Vorgaengerfassung (`sitzungssperre.ts`, eine
 * `Map` im Modul-Scope) behauptete in ihrem Kopf genau diesen Schutz, ohne
 * den Zusatz „nur im selben Tab" — nachgemessen in
 * `test/krypto-sperren.test.ts`: zwei Modul-Instanzen liefen ungehindert
 * gleichzeitig.
 *
 * **Der Mechanismus: Web Locks** (`navigator.locks`). Eingebaut, keine neue
 * Abhaengigkeit, und genau auf diesen Zuschnitt gebaut: eine Sperre gilt je
 * HERKUNFT ueber alle Tabs, Worker und Frames; sie wird freigegeben, sobald
 * das Versprechen der Aufgabe sich entscheidet — auch bei einem Fehler —,
 * und der Browser gibt sie ausserdem frei, wenn der haltende Tab
 * verschwindet. Damit kann eine geworfene Ausnahme den Klienten nicht still
 * lahmlegen; das Rueckgabe-Versprechen von `request` traegt den Fehler
 * unveraendert an den Aufrufer zurueck.
 *
 * **Kein stiller Rueckfall — fehlt `navigator.locks`, wird geworfen.** Ein
 * Rueckfall, der nur so tut, waere schlimmer als gar keiner: der Aufrufer
 * glaubt, geschuetzt zu sein, und die Schaeden (ueberschriebene private
 * Schluesselhaelften, zweimal derselbe Megolm-Ratchet-Platz) sind endgueltig
 * und unsichtbar. Der Wurf kostet nichts, was nicht ohnehin fehlt: Web Locks
 * sind auf sichere Kontexte beschraenkt — genau wie `crypto.subtle`, und
 * OHNE `crypto.subtle` kommt keine dieser Stellen auch nur bis zur Sperre
 * (`identity/keypair.svelte.ts::signChallenge` signiert den Pickle-Kontext,
 * `account.svelte.ts::pickelschluesselDesGeraets`). Wo die Sperre fehlt,
 * fehlt also auch der Schluessel, mit dem es etwas zu schuetzen gaebe.
 *
 * **Zwei Regeln, ohne die das hier bricht:**
 *
 *  1. **Web Locks sind NICHT wiedereintrittsfaehig.** Eine Aufgabe, die
 *     unter `mitKontosperre` laeuft, darf `mitKontosperre` nicht erneut
 *     rufen — sie wartete auf sich selbst, fuer immer. Deshalb sperrt in
 *     diesem Baum ausschliesslich die AUFRUFENDE Ablaufstelle
 *     (`veroeffentlichen.ts`, `empfangen.ts`, `senden.ts`,
 *     `gruppe/senden.ts`, `zustellungOeffnen.ts`), nie eine der Lade-/
 *     Sicher-Hilfen (`account.svelte.ts`, `sitzungen.ts`,
 *     `gruppe/gruppenSitzungen.ts`). Wer das umdreht, baut den Selbstblock.
 *  2. **Eine feste Reihenfolge, sonst Verklemmung.** Erworben wird immer
 *     Konto → Gruppensitzung → Olm-Sitzung, nie umgekehrt: der Abholzyklus
 *     haelt die Konto-Sperre und nimmt darunter Sitzungssperren, der
 *     Gruppen-Sendeweg haelt die Gruppensperre und nimmt darunter
 *     Sitzungssperren. Keine Stelle nimmt unter einer Sitzungssperre eine
 *     Konto- oder Gruppensperre.
 *
 * **Was diese Sperre NICHT leistet:** sie beendet keinen haengenden
 * Netzaufruf. Bleibt eine Anfrage im haltenden Tab unentschieden (der
 * API-Klient setzt keine Frist), warten die uebrigen Tabs, bis dieser Tab
 * geschlossen wird. Das war vorher schon der Zustand DIESES Tabs; neu ist,
 * dass es die anderen mit betrifft. Eine Frist waere hier die falsche
 * Antwort: sie liefe auf „nach n Sekunden ungeschuetzt weitermachen" hinaus,
 * und genau das ist der Schaden. Die laengste absehbare Wartezeit ist ein
 * Abholzyklus mit Anhaengen (`empfangen.ts` laedt die Bytes vor der Quittung)
 * — solange kann in einem ZWEITEN Tab Schritt 5 des Anmeldeflusses warten
 * (`identity/issue-flow.ts`, dort ohnehin best-effort und ohne Wirkung auf
 * die Anmeldung selbst).
 */

/** Wird geworfen, wenn die Umgebung keine Web Locks anbietet — s. Modulkopf. */
export class SperrenNichtVerfuegbar extends Error {
  constructor() {
    super(
      'navigator.locks fehlt — der Krypto-Zustand laesst sich in dieser ' +
        'Umgebung nicht tab-uebergreifend absichern (kein stiller Rueckfall, ' +
        's. krypto/sperren.ts).'
    );
    this.name = 'SperrenNichtVerfuegbar';
  }
}

/**
 * Der Ausschnitt der Web-Locks-API, den dieses Modul braucht. Eigene
 * Deklaration statt `lib.dom`: dieses Modul bleibt importfrei und soll auch
 * dort typpruefbar sein, wo die DOM-Typen nicht geladen sind — und die
 * schmale Form macht im Test eine Nachbildung moeglich.
 */
export interface Sperrverwalter {
  request<T>(name: string, optionen: { mode: 'exclusive' }, aufgabe: () => Promise<T>): Promise<T>;
}

/** Erst beim Sperren nachschlagen, nicht beim Laden des Moduls: `navigator`
 *  existiert im Testlaeufer erst, nachdem der Test ihn gestellt hat, und in
 *  der App wird dieses Modul frueh importiert. */
function sperrverwalter(): Sperrverwalter {
  const umgebung = globalThis as { navigator?: { locks?: Sperrverwalter } };
  const locks = umgebung.navigator?.locks;
  if (!locks) throw new SperrenNichtVerfuegbar();
  return locks;
}

/** Gemeinsamer Namensraum — Web-Locks-Namen gelten je Herkunft, und die App
 *  teilt sich diese Herkunft mit allem anderen, was hier Sperren nimmt. */
const PRAEFIX = 'pulse.krypto.';

/**
 * Der Krypto-Account dieses Geraets — EINE Sperre fuer alles, was ihn laedt,
 * veraendert und wieder einfriert. Global (nicht je Gespraech), weil es genau
 * einen Account gibt: ein zweiter Name waere ein zweiter Zustand, den es
 * nicht gibt.
 */
export const KONTO_SPERRE = `${PRAEFIX}konto`;

/** Je Geraetepaar eine eigene Sperre (`sitzungsSchluessel` = `kanal:geraet`),
 *  damit zwei unabhaengige Gespraeche einander nicht ausbremsen. */
export function sitzungsSperrname(sitzungsSchluessel: string): string {
  return `${PRAEFIX}sitzung.${sitzungsSchluessel}`;
}

/** Je Kanal eine eigene Sperre — die ausgehende Megolm-Sitzung eines Kanals
 *  ist der einzige Zustand, den zwei Sendungen in DIESEN Kanal teilen. */
export function gruppensitzungsSperrname(kanalId: string): string {
  return `${PRAEFIX}gruppensitzung.${kanalId}`;
}

/**
 * Fuehrt `aufgabe` aus, waehrend dieser Tab die Sperre `name` exklusiv haelt
 * — ueber alle Tabs derselben Herkunft hinweg. Gibt zurueck, was `aufgabe`
 * zurueckgibt; wirft `aufgabe`, wird die Sperre trotzdem freigegeben und der
 * Fehler unveraendert weitergereicht.
 */
export async function mitSperre<T>(name: string, aufgabe: () => Promise<T>): Promise<T> {
  // `async`, damit auch `SperrenNichtVerfuegbar` als ABLEHNUNG herauskommt
  // und nicht als synchroner Wurf: die Aufrufer behandeln diese Funktion als
  // Versprechen, und ein synchroner Wurf ginge an einem `.catch()` vorbei.
  return sperrverwalter().request(name, { mode: 'exclusive' }, aufgabe);
}

/** Sperrt den Krypto-Account. MUSS Laden, Veraendern UND Sichern umschliessen
 *  — eine Sperre nur ums Sichern verhindert nichts, der verlorene Stand
 *  entsteht schon beim Laden. */
export function mitKontosperre<T>(aufgabe: () => Promise<T>): Promise<T> {
  return mitSperre(KONTO_SPERRE, aufgabe);
}

/** Sperrt eine Olm-Sitzung (`kanal:geraet`, s. `sitzungsschluessel.ts`). */
export function mitSchluesselsperre<T>(
  sitzungsSchluessel: string,
  aufgabe: () => Promise<T>
): Promise<T> {
  return mitSperre(sitzungsSperrname(sitzungsSchluessel), aufgabe);
}

/** Sperrt die ausgehende Gruppensitzung eines Kanals. */
export function mitGruppensitzungssperre<T>(
  kanalId: string,
  aufgabe: () => Promise<T>
): Promise<T> {
  return mitSperre(gruppensitzungsSperrname(kanalId), aufgabe);
}
