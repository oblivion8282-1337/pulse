/**
 * Vergleicht zwei Snowflake-IDs (als Strings über die API-Grenze, da JS-`Number`
 * 64-Bit nicht exakt halten kann).
 *
 * Snowflakes sind als Integer zeitlich monoton, aber ihre **Dezimal-Länge wächst**
 * über die Zeit (Epoch 2026-01-01). Ein reiner lexikografischer String-Vergleich
 * ist nur bei **gleicher Länge** korrekt: `"99999999999999999"` (17) vs.
 * `"100000000000000000"` (18) ergäbe lexikografisch `"1…" < "9…"`, obwohl der
 * 18-stellige Wert numerisch (= zeitlich neuer) größer ist → Fehlordnung an der
 * Stellen-Grenze (z.B. Okt 2026, wenn IDs von 17 auf 18 Stellen springen).
 *
 * Daher: zuerst nach Länge (kein führendes Null in Snowflake-Strings → längere
 * Zahl ist immer größer), dann lexikografisch. Bei gleicher Länge identisch zum
 * bisherigen `a < b`-Verhalten (= kein Verhaltenswechsel für aktuelle IDs).
 */
export function compareSnowflakeId(a: string, b: string): number {
  if (a.length !== b.length) return a.length - b.length;
  return a < b ? -1 : a > b ? 1 : 0;
}
