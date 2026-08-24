/**
 * Welcher Bildschirm ist DIESES Fenster — die reine Auswahlregel hinter der
 * Markierung `dieses_fenster` in `devices/schirme.svelte.ts`.
 *
 * **Eigenes Modul neben `quellenummer.ts`** (wo `zuordneStroeme` und
 * `zuordnungIstEindeutig` wohnen, auf die diese Regel aufbaut): dort geht es um
 * die Zuordnung ueberhaupt, hier um die Sicht EINES Fensters darauf. Der Import
 * unten braucht eine Dateiendung, sonst loest ihn nur der Bundler auf, Nodes
 * eingebauter Testlaeufer nicht (s. `CLAUDE.md`, Muster wie
 * `remote/zeigerbildPruefung.ts`).
 */

import {
  zuordneStroeme,
  zuordnungIstEindeutig,
  type MonitorFuerZuordnung,
  type StromFuerZuordnung,
  type Zuordnungslage,
} from './quellenummer.ts';

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
 *
 * `lage` wird unveraendert durchgereicht — beide Rechnungen muessen von
 * derselben Bildschirmliste ausgehen, sonst pruefte die eine etwas anderes als
 * die andere auswertet.
 */
export function schirmFuerFenster<S extends StromFuerZuordnung>(
  stroeme: ReadonlyArray<S>,
  monitore: ReadonlyArray<MonitorFuerZuordnung>,
  geraetePlaetze: ReadonlySet<number>,
  fensterSlot: number,
  lage: Zuordnungslage = {},
): number | null {
  if (!zuordnungIstEindeutig(stroeme, monitore, geraetePlaetze, lage)) return null;
  const { karte } = zuordneStroeme(stroeme, monitore, geraetePlaetze, lage);
  for (const [index, strom] of karte) {
    if (strom.slot === fensterSlot) return index;
  }
  return null;
}
