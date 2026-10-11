/**
 * Den Abmelder eines Capacitor-Hörers bauen — gleich, ob `addListener` ein
 * Promise auf den Griff geliefert hat oder den Griff selbst.
 *
 * **Warum es zwei Formen gibt.** Über `registerPlugin` kommt ein Promise auf
 * `{ remove }` (`@capacitor/core`, `addListenerNative`). Das ROHE Objekt aus
 * `window.Capacitor.Plugins.X`, das die iOS-Hülle für jedes Plugin anlegt
 * (`JSExport.exportJS`), reicht `addListener` dagegen an `Capacitor.addListener`
 * aus `native-bridge.js` (`initEvents`) — und das gibt `{ remove }` SOFORT
 * zurück, ohne Promise. Beides am Quelltext gelesen (`@capacitor/core` 8.4.0,
 * `@capacitor/ios` 8.5.2), nicht am Gerät gemessen.
 *
 * `iosAudioSession.ts` greift über das rohe Objekt zu und rief bis zum
 * 2026-10-11 `griff.then(…)` — beim Abmelden ein `TypeError`, und der Hörer
 * blieb angemeldet. Aufgefallen ist es nie, weil keine der drei Anmeldungen
 * je abmeldet — sie leben so lange wie die Seite (`audioRouteState`,
 * `iosTon`, `hqStreamManager`).
 *
 * Importfrei (CLAUDE.md, `pnpm test:unit`).
 */

export type HoererGriff = { remove: () => unknown };

/** Abmelden wirft nie: ein Hörer, der nicht mehr gehen will, ist kein Grund,
 *  den Aufrufer mitzureissen. */
export function abmelder(griff: HoererGriff | Promise<HoererGriff>): () => void {
  return () => {
    void Promise.resolve(griff)
      .then((g) => g.remove())
      .catch(() => undefined);
  };
}
