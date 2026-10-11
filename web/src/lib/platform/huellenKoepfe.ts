/**
 * Kennt der installierte App-Bau ein Plugin — und jede Methode, die die
 * Oberfläche daran ruft? Die reine Rechnung; die Hülle drumherum steht in
 * `huelleKann.ts`.
 *
 * **Warum es diese Frage überhaupt gibt.** Web und Hülle werden getrennt
 * ausgeliefert: die Oberfläche kommt bei jedem Start frisch vom Server, die
 * App nur über den Store. Ein Telefon mit älterem Bau bekommt also eine
 * Oberfläche, die Methoden ruft, die es dort nicht gibt.
 * `Capacitor.isPluginAvailable` beantwortet nur die halbe Frage — das Plugin
 * kann da sein, die Methode trotzdem fehlen. So am 2026-10-11 beim nativen
 * Sprachweg: das Telefon des Eigentümers trug ein `SprachePlugin` mit fünf
 * Methoden, die Oberfläche rief elf.
 *
 * **Die Quelle sind die Köpfe, die die Hülle beim Laden der Seite einspielt**
 * (`Capacitor.PluginHeaders`, je Plugin des Baus ein Eintrag; erzeugt in
 * Capacitors `JSExport.exportJS` aus derselben `pluginMethods`-Liste, nach
 * der die Hülle Rufe annimmt — Typ in `@capacitor/core`,
 * `definitions-internal.d.ts`). Was dort nicht steht, kennt der Bau nicht.
 *
 * Importfrei, damit Nodes Läufer es prüfen kann (CLAUDE.md, `pnpm test:unit`).
 */

/** Ein Eintrag aus `Capacitor.PluginHeaders`. */
export interface PluginKopf {
  name: string;
  methods: readonly { name: string; rtype?: string | null }[];
}

export type PluginBefund =
  | { da: true }
  | { da: false; grund: 'kein-plugin' }
  | { da: false; grund: 'methoden-fehlen'; fehlen: string[] };

/**
 * Trägt der Bau `plugin` mit allen `methoden`? `fehlen` nennt genau die
 * fehlenden, in der Reihenfolge der Anfrage — für die Diagnose.
 *
 * **Misstrauisch gegen die Form**, weil sie von aussen kommt: ein Kopf ohne
 * Methodenliste oder eine Liste, die keine ist, gilt als „kennt nichts", nicht
 * als Fehler. Lieber einmal zu oft auf den Rückfallweg als einmal zu oft auf
 * einen Weg, der halb fehlt.
 */
export function pluginBefund(
  koepfe: unknown,
  plugin: string,
  methoden: readonly string[]
): PluginBefund {
  const kopf = Array.isArray(koepfe)
    ? (koepfe as Partial<PluginKopf>[]).find((k) => k?.name === plugin)
    : undefined;
  if (!kopf) return { da: false, grund: 'kein-plugin' };
  const bekannt = new Set(
    Array.isArray(kopf.methods) ? kopf.methods.map((m) => m?.name) : []
  );
  const fehlen = methoden.filter((m) => !bekannt.has(m));
  return fehlen.length === 0 ? { da: true } : { da: false, grund: 'methoden-fehlen', fehlen };
}
