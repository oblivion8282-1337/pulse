/**
 * Welcher Strom zeigt welchen Bildschirm — die **Bildschirm-Nummer** und die
 * Zuordnungsregel darauf.
 *
 * **Eigenes Modul und nicht in `settingsCatalog.ts`**: der ist der Werte-Katalog
 * der Stream-Einstellungen (Codec-, Auflösungs-, Ton-Listen). Zuordnungslogik
 * Strom↔Bildschirm ist etwas anderes, und hinter den Katalog gehängt wuchs die
 * Datei auf 470 von harten 500 Zeilen (PLAN.md §12.1), ohne dass ihr Kopf noch
 * gestimmt hätte. Der Test heisst seit jeher `web/test/quellenummer.test.ts` —
 * jetzt findet man auch die Datei dazu.
 *
 * **Diese Datei muss für Nodes eingebauten Testläufer erreichbar bleiben**
 * (`pnpm test:unit`, kein Vitest): kein erweiterungsloser Laufzeit-Import, der
 * Bundler löst ihn auf, Node nicht (s. `CLAUDE.md`). Der eine Import unten
 * trägt deshalb seine `.ts`-Endung; `settingsCatalog.ts` selbst ist importfrei.
 * `MONITOR_CAPTURE_PREFIX` bleibt dort, weil er zur Aufnahmequelle gehört und
 * nicht zur Zuordnung — eine zweite Schreibweise des Vorsatzes wäre die
 * schlechtere Hälfte des Tauschs.
 */

import { MONITOR_CAPTURE_PREFIX } from './settingsCatalog.ts';

/**
 * Kleinste gültige Bildschirm-Nummer. **1, nicht 0.**
 *
 * Die Nummern sind 1-basiert (alle Sidecars zählen so, s.
 * `ops/list_monitors.rs` auf Windows und macOS; Linux nimmt den Portal-Weg und
 * hat gar keine). Die **0 ist anderweitig vergeben** und darf hier deshalb
 * nicht durchrutschen: `devices/schirme.svelte.ts` erfindet für ein Gerät ohne
 * gemeldete Bildschirmliste genau einen Ersatz-Eintrag mit `index: 0`, und
 * `devices/wecken.ts` liest eine 0 als „keine Nummer, nimm die Quelle aus
 * deinem Profil". Eine 0 auf dem Draht passte also zufällig auf diesen
 * Ersatz-Eintrag und schlüge einen Strom dem falschen Bildschirm zu.
 *
 * Dieselbe Zahl steht serverseitig in `dcc_shared/streaming.py`
 * (`MONITOR_INDEX_MIN`) — **synchron halten**, es gibt keinen Importweg von
 * Python nach TypeScript.
 */
export const MONITOR_INDEX_MIN = 1;

/**
 * Aus einer Aufnahmequelle die Bildschirm-Nummer lesen.
 *
 * `undefined` für alles, was kein Monitor ist — Fenster-Aufnahmen, der
 * Linux-Portal-Platzhalter, Unfug, und ebenso die 0 (s.
 * {@link MONITOR_INDEX_MIN}). Geraten wird nichts: eine erfundene Nummer
 * zeigte beim Zuschauer auf einen Bildschirm, den der Strom gar nicht zeigt.
 */
export function monitorNummer(captureSource: string | undefined | null): number | undefined {
  const src = (captureSource ?? '').trim();
  if (!src.startsWith(MONITOR_CAPTURE_PREFIX)) return undefined;
  const roh = src.slice(MONITOR_CAPTURE_PREFIX.length).trim();
  if (roh === '') return undefined;
  const n = Number(roh);
  return Number.isInteger(n) && n >= MONITOR_INDEX_MIN ? n : undefined;
}

/** Was die Zuordnung von einem Strom braucht. Absichtlich schmal — so lässt
 *  sie sich ohne Stores prüfen. */
export interface StromKennung {
  label?: string;
  monitor_index?: number;
}

/** Und was sie von einem Bildschirm braucht. */
export interface MonitorKennung {
  index: number;
  name: string;
}

/**
 * Zeigt dieser Strom diesen Bildschirm?
 *
 * **Die Nummer gewinnt.** Trägt der Strom eine, entscheidet allein sie — auch
 * wenn der Name danebenliegt (umbenannter Monitor, andere Sprache, fehlender
 * EDID-Name). Der Namensvergleich bleibt als Rückfall für Klienten, die die
 * Nummer noch nicht mitschicken; er ist nachsichtig bei Rand und
 * Gross-/Kleinschreibung, weil ein Unterschied dort nicht auffällt, sondern
 * still das Falsche tut.
 *
 * **Der Grund für die Nummer:** zwei baugleiche Monitore heissen gleich. Ohne
 * sie passt derselbe Strom auf beide, und die Zuordnung ist nicht zu treffen.
 *
 * **Achtung, das gilt nur INNERHALB eines Stroms.** Ob ein nummerierter Strom
 * auch gegen einen namensgleichen ANDEREN gewinnt, entscheidet nicht diese
 * Funktion, sondern die Reihenfolge in {@link zuordneStroeme} — dort steht,
 * warum das eine eigene Runde braucht.
 */
export function stromPasstZuMonitor(strom: StromKennung, mon: MonitorKennung): boolean {
  if (typeof strom.monitor_index === 'number') return strom.monitor_index === mon.index;
  const a = strom.label?.trim().toLowerCase();
  if (!a) return false;
  return a === mon.name.trim().toLowerCase() || a === `monitor ${mon.index}`;
}

/** Was die Zuordnung zusätzlich von einem Strom braucht, um den Notbehelf
 *  für den namenlosen Hauptbildschirm zu prüfen: seinen Sende-Platz. */
export interface StromFuerZuordnung extends StromKennung {
  slot: number;
}

/** Was die Zuordnung zusätzlich von einem Bildschirm braucht: ob er der
 *  Hauptbildschirm ist. */
export interface MonitorFuerZuordnung extends MonitorKennung {
  primary: boolean;
}

/**
 * Woher die Bildschirmliste stammt — das eine Stück Zusammenhang, das die
 * Zuordnung nicht aus ihren Argumenten ablesen kann.
 */
export interface Zuordnungslage {
  /**
   * Hat das Gerät seine Bildschirme wirklich gemeldet?
   *
   * `false` heisst: die übergebene Liste ist **erfunden** — der eine
   * Ersatz-Eintrag, den `devices/schirme.svelte.ts::monitorListe` für ein
   * Gerät ohne gemeldete Schirme baut (`index: 0`). Dann kann keine echte
   * Nummer darin vorkommen, und der Notbehelf unten muss auch nummerierte
   * Ströme annehmen; sonst bliebe ein Gerät, dessen `refreshMonitors()` einmal
   * fehlschlug, dauerhaft unsichtbar. Vorgabe `true`: wer eine echte Liste
   * hat, muss nichts angeben.
   */
  listeGemeldet?: boolean;
}

/** Ergebnis von {@link zuordneStroeme}. */
export interface Zuordnung<S extends StromFuerZuordnung> {
  /** Monitor-Index → zugeordneter Strom. */
  karte: Map<number, S>;
  /** Monitor-Indizes, deren Eintrag NUR aus dem Notbehelf stammt (kein Strom
   *  hat wirklich zu ihnen gepasst) — eine Annahme, keine Feststellung. */
  geraten: Set<number>;
}

/**
 * Welcher Strom zeigt welchen Bildschirm — die reine Zuordnungsregel hinter
 * `devices/schirme.svelte.ts::zuordnung()`. Hier ohne Stores, damit Nodes
 * eingebauter Testläufer sie prüfen kann.
 *
 * **Zwei Runden je Bildschirm, und die Reihenfolge ist der Punkt**: erst der
 * Strom, dessen NUMMER auf ihn zeigt, und nur wenn keiner das tut, der
 * Namenstreffer. Eine einzige Runde nähme den ersten passenden Strom der Liste
 * — und die ist nach `(user, slot)` sortiert, Platz 0 also zuerst. Überträgt
 * der Besitzer nebenher von Hand einen Bildschirm (Platz 0, Name „Dell", ohne
 * Nummer), während sein Standplatz-Gerät denselben Schirm mit `monitor_index`
 * auf Platz 1 zeigt, gewänne der Namenstreffer: der nummerierte Gerätestrom
 * bliebe unzugeordnet, `zuordnungIstEindeutig` meldete trotzdem `true` (er
 * trägt ja eine Nummer), und ein Klick auf „Monitor 1" öffnete das falsche
 * Fenster. „Die Nummer gewinnt" muss also auch ZWISCHEN Strömen gelten, nicht
 * nur innerhalb eines einzelnen.
 *
 * **Bleibt der Hauptbildschirm danach frei**, UND gibt es einen Strom DES
 * GERÄTS (`geraetePlaetze`, dieselbe Quelle wie
 * `darstellung.ts::stromGehoertGeraet`), der zu KEINEM Bildschirm passt, wird
 * dieser Strom dem Hauptbildschirm als Notbehelf zugeschlagen (Bughunt
 * 2026-08-17, Begründung in `schirme.svelte.ts::zuordnung()`) — der einzige
 * Weg, auf dem ein Klient ohne Nummer und mit unpassendem Namen (Linux-
 * Portal-Aufnahme, allgemeiner Ersatzname, verändertes Profil) überhaupt
 * sichtbar wird.
 *
 * **Das ist eine Annahme, keine Feststellung** — der Rückgabewert `geraten`
 * nennt genau diese Fälle, damit Aufrufer wie {@link zuordnungIstEindeutig}
 * sie nicht für sicher halten.
 */
export function zuordneStroeme<S extends StromFuerZuordnung>(
  stroeme: ReadonlyArray<S>,
  monitore: ReadonlyArray<MonitorFuerZuordnung>,
  geraetePlaetze: ReadonlySet<number>,
  lage: Zuordnungslage = {},
): Zuordnung<S> {
  const listeGemeldet = lage.listeGemeldet ?? true;
  const karte = new Map<number, S>();
  for (const mon of monitore) {
    const treffer =
      stroeme.find((s) => s.monitor_index === mon.index) ??
      stroeme.find((s) => stromPasstZuMonitor(s, mon));
    if (treffer) karte.set(mon.index, treffer);
  }
  // Ein Strom MIT Nummer ist nie „namenlos" — auch dann nicht, wenn seine
  // Nummer zu keinem aktuell gemeldeten Bildschirm passt (Profil auf eine
  // inzwischen verschwundene Quelle gestellt). Er darf über diesen Notbehelf
  // nie einem anderen Bildschirm zugeschlagen werden: gegen eine ECHTE Liste
  // ist die Nummer eine ausdrückliche, verlässliche Angabe.
  //
  // **Gegen eine ERFUNDENE Liste ist sie das gerade nicht** (`listeGemeldet`):
  // der eine Ersatz-Eintrag trägt `index: 0`, eine Nummer ≥ 1 kann darauf gar
  // nicht passen. Ohne diese Ausnahme fiel ein Gerät, dessen
  // `refreshMonitors()` beim Anmelden einmal fehlschlug (`anmeldung.svelte.ts`
  // fängt still, es gibt kein Nachmelden), aus der Zuordnung heraus: der
  // Ersatz-Schirm galt als frei, `holen()` weckte ohne Nummer, das Gerät
  // erkannte die Quelle als laufend und verwarf wortlos — und der Wunsch
  // wartete auf einen Platz, der nie kam.
  const namenlos = stroeme.find(
    (s) =>
      (!listeGemeldet || s.monitor_index === undefined) &&
      geraetePlaetze.has(s.slot) &&
      !monitore.some((mon) => stromPasstZuMonitor(s, mon)),
  );
  const haupt = monitore.find((mon) => mon.primary);
  const geraten = new Set<number>();
  // Einen Bildschirm, der schon seinen eigenen Strom hat, nicht überschreiben:
  // der zugeordnete ist der genauere.
  if (namenlos && haupt && !karte.has(haupt.index)) {
    karte.set(haupt.index, namenlos);
    geraten.add(haupt.index);
  }
  return { karte, geraten };
}

/**
 * Ist die Zuordnung Strom → Bildschirm eindeutig — für JEDEN Bildschirm
 * entweder unbelegt oder mit einem SICHEREN Treffer belegt?
 *
 * Unsicher wird sie durch zwei unabhängige Fälle:
 * - ein Strom OHNE Nummer passt auf **mehr als einen** Bildschirm (zwei
 *   baugleiche Monitore beim Host, Klient ohne Nummer);
 * - ein Eintrag stammt aus dem **Notbehelf** von {@link zuordneStroeme}
 *   (`geraten`) statt aus einem echten Treffer. **Null Treffer heisst hier
 *   GERATEN, nicht eindeutig** — das ist die Stelle, an der man sich am
 *   leichtesten wieder vertut: der Notbehelf liefert zuverlässig dasselbe
 *   Ergebnis, aber nicht zuverlässig das RICHTIGE. „Deterministisch" ist
 *   nicht dasselbe wie „sicher richtig".
 *
 * Rechnet über dieselbe {@link zuordneStroeme} wie die Karte selbst — keine
 * zweite Auflösung daneben, sonst liefen beide auseinander. Ein Strom MIT
 * Nummer gilt gegen eine echte Liste immer als eindeutig — genau deshalb wurde
 * sie eingeführt; gegen eine erfundene Liste fängt ihn der `geraten`-Zweig ab.
 */
export function zuordnungIstEindeutig<S extends StromFuerZuordnung>(
  stroeme: ReadonlyArray<S>,
  monitore: ReadonlyArray<MonitorFuerZuordnung>,
  geraetePlaetze: ReadonlySet<number>,
  lage: Zuordnungslage = {},
): boolean {
  const { geraten } = zuordneStroeme(stroeme, monitore, geraetePlaetze, lage);
  if (geraten.size > 0) return false;
  return stroeme.every((s) => {
    if (s.monitor_index !== undefined) return true;
    return monitore.filter((mon) => stromPasstZuMonitor(s, mon)).length <= 1;
  });
}
