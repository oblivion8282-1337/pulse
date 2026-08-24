/**
 * Welcher Bildschirm ist DIESES Fenster — die reine Auswahlregel hinter der
 * Markierung `dieses_fenster` in `devices/schirme.svelte.ts`.
 *
 * **Eigenes Modul statt in `settingsCatalog.ts`** (wo `zuordneStroeme` und
 * `zuordnungIstEindeutig` wohnen, auf die diese Regel aufbaut): die Datei
 * steht schon bei 470 von harten 500 Zeilen (PLAN.md §12.1) — dort darf kaum
 * noch etwas dazukommen. Der Import unten braucht eine Dateiendung, sonst
 * loest ihn nur der Bundler auf, Nodes eingebauter Testlaeufer nicht (s.
 * `CLAUDE.md`, Muster wie `remote/zeigerbildPruefung.ts`).
 */

import {
  zuordneStroeme,
  zuordnungIstEindeutig,
  type MonitorFuerZuordnung,
  type StromFuerZuordnung,
} from './settingsCatalog.ts';

/**
 * Jedes Fenster meldet nur seinen eigenen Sende-Platz (`fensterSlot`);
 * gesucht wird der Bildschirm, dessen zugeordneter Strom genau diesen Platz
 * traegt.
 *
 * **Fail-visible:** ist die Zuordnung insgesamt NICHT eindeutig
 * ({@link zuordnungIstEindeutig}), liefert diese Funktion `null` — lieber gar
 * keine Markierung als eine geratene. Rechnet ueber dieselbe
 * {@link zuordneStroeme} wie die Eindeutigkeitspruefung selbst, keine zweite
 * Aufloesung daneben.
 */
export function schirmFuerFenster<S extends StromFuerZuordnung>(
  stroeme: ReadonlyArray<S>,
  monitore: ReadonlyArray<MonitorFuerZuordnung>,
  geraetePlaetze: ReadonlySet<number>,
  fensterSlot: number,
): number | null {
  if (!zuordnungIstEindeutig(stroeme, monitore, geraetePlaetze)) return null;
  const { karte } = zuordneStroeme(stroeme, monitore, geraetePlaetze);
  for (const [index, strom] of karte) {
    if (strom.slot === fensterSlot) return index;
  }
  return null;
}
