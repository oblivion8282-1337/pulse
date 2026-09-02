import { vergleicheSnowflakeArtigeId } from './snowflakeZeit.ts';

/**
 * Vergleicht zwei Snowflake-IDs (als Strings über die API-Grenze, da JS-`Number`
 * 64-Bit nicht exakt halten kann).
 *
 * Snowflakes sind als Integer zeitlich monoton, aber ihre **Dezimal-Länge wächst**
 * über die Zeit (Epoch 2026-01-01) — ein reiner lexikografischer oder
 * längen-zuerst-Vergleich ist deshalb nur korrekt, solange ALLE verglichenen
 * IDs aus demselben Schema stammen. Seit den Ende-zu-Ende-verschlüsselten
 * DMs gilt das nicht mehr: `krypto/senden.ts::lokaleNachrichtId()` vergibt
 * lokale, fest 20-stellige Kennungen, während echte Server-Snowflakes heute
 * 17 Stellen haben — eine lokale ID wäre nach "Länge zuerst" IMMER als
 * jünger einsortiert worden, unabhängig vom echten Zeitpunkt (Bughunt Fund 1,
 * s. `web/test/snowflake-vergleich.test.ts`). Die eigentliche Rechnung
 * (eingebettete Zeit entschlüsseln und die vergleichen) steht deshalb in
 * `./snowflakeZeit.ts` — dieselbe Rechnung, die `verlauf/zusammenfuegen.ts`
 * für denselben Fall braucht.
 */
export function compareSnowflakeId(a: string, b: string): number {
  return vergleicheSnowflakeArtigeId(a, b);
}
