/**
 * Systemschriftgröße → Textskalierung der Web-App (iOS-Liste Punkt 38).
 *
 * **Was heute fehlt.** Wer am iPhone eine größere Schrift einstellt, bekommt
 * in Pulse nichts davon: eine WKWebView mit `width=device-width` schaltet die
 * Textvergrößerung von selbst ab, und `-webkit-text-size-adjust` ist nirgends
 * gesetzt. Die Einstellung wirkt in jeder Systemapp und in Safari — nur nicht
 * hier.
 *
 * **Warum `-webkit-text-size-adjust` und nicht die Wurzel-Schriftgröße.** Alle
 * Größen dieser App stehen in `rem` (Tailwind: `--text-2xs: 0.6875rem`,
 * Abstände ebenso). Eine größere Wurzel-Schriftgröße skaliert deshalb das
 * ganze LAYOUT mit — und dort gibt es harte Zusagen, etwa dass die
 * Sprach-Knopfreihe einzeilig bleibt (Begründung in `VoiceControlBar`) und
 * dass jede Trefferfläche 48 dp hat (gemessen in
 * `tests/e2e/mobile-treffflaechen.spec.ts`). `-webkit-text-size-adjust`
 * vergrößert den TEXT und lässt die Kästen, in denen er sitzt, unberührt.
 *
 * **Die Obergrenze ist eine Entscheidung, keine Bequemlichkeit.** iOS reicht
 * bis `AX5` — das ist etwa das Dreifache. Text, der auf das Dreifache wächst,
 * während sein Kasten gleich bleibt, ist nicht groß, sondern abgeschnitten.
 * `MAX_SKALA` begrenzt deshalb auf 160 %: deutlich spürbar, und noch innerhalb
 * dessen, was die Kästen tragen. **Ungemessen** — die Zahl ist gesetzt, nicht
 * erprobt; was wirklich passt, zeigt erst ein Durchgang mit eingeschalteter
 * Großschrift am Gerät.
 *
 * Importfrei und damit prüfbar (s. die `pnpm test:unit`-Falle in CLAUDE.md).
 */

/** Kleiner als normal wird nichts — wer winzige Schrift will, bekommt die
 *  Vorgabe. Ein Verkleinern unter 100 % würde Trefferflächen und Lesbarkeit
 *  verschlechtern, ohne dass jemand danach gefragt hat. */
export const MIN_SKALA = 100;
/** Obergrenze in Prozent, s. Kopfkommentar. */
export const MAX_SKALA = 160;

/**
 * Apples Kategorien in Prozent. Die Werte folgen den Schriftgrößen, die iOS
 * für `body` in der jeweiligen Kategorie ausliefert (17 pt bei `L`), auf
 * ganze Prozent gerundet — die fünf `AX`-Stufen laufen danach in die
 * Obergrenze.
 */
const KATEGORIEN: Record<string, number> = {
  UICTContentSizeCategoryXS: 100,
  UICTContentSizeCategoryS: 100,
  UICTContentSizeCategoryM: 100,
  UICTContentSizeCategoryL: 100,
  UICTContentSizeCategoryXL: 112,
  UICTContentSizeCategoryXXL: 124,
  UICTContentSizeCategoryXXXL: 135,
  UICTContentSizeCategoryAccessibilityM: 160,
  UICTContentSizeCategoryAccessibilityL: 160,
  UICTContentSizeCategoryAccessibilityXL: 160,
  UICTContentSizeCategoryAccessibilityXXL: 160,
  UICTContentSizeCategoryAccessibilityXXXL: 160
};

/**
 * Prozentwert für eine Kategorie. Unbekanntes ergibt 100 — eine neue
 * iOS-Kategorie darf keine wilde Skalierung auslösen, nur keine.
 */
export function skalaFuerKategorie(kategorie: string | null | undefined): number {
  if (!kategorie) return MIN_SKALA;
  const roh = KATEGORIEN[kategorie];
  if (roh === undefined) return MIN_SKALA;
  return Math.min(MAX_SKALA, Math.max(MIN_SKALA, roh));
}
