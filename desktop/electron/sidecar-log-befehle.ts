/**
 * Welche **ausgehenden** Befehle in der `sidecar.log` landen — und wie sie
 * vorher von Geheimnissen befreit werden.
 *
 * **Der Anlass** (2026-08-17): mitgeschrieben wurden bis dahin nur `[out]` und
 * `[err]`, also die Antworten. Die Fragen — was Electron dem Sidecar bzw. dem
 * Player über stdin schickt — standen nirgends. Bei der Untersuchung des
 * Vorfalls vom selben Tag war damit die entscheidende Frage nicht zu
 * beantworten: Der Sender hörte auf zu übertragen, und aus dem Protokoll ging
 * nicht hervor, ob ihm das jemand befohlen hatte oder ob er von sich aus
 * aufgab. Beides sieht von aussen gleich aus.
 *
 * **Warum eine Positivliste und keine Rausch-Regel.** Die Nachbarn
 * (`sidecar-log-noise.ts`, `sidecar-log-drossel.ts`) unterdrücken, was zu viel
 * ist. Für die Gegenrichtung ist das die falsche Richtung: die Eingabe-Ops der
 * Fernsteuerung laufen mit bis zu 125 Anfragen je Sekunde (s. `player.ts`), und
 * eine Regel, die sie einzeln ausschliesst, muss bei jedem neuen Op erneut
 * richtig sein. Vergisst sie einer, füllt sich die Datei binnen Minuten, sie
 * rotiert (`sidecar-log.ts`, 2 MB) — und weg ist genau das, wonach jemand
 * sucht. Eine Positivliste kann diesen Fehler nicht machen: was nicht
 * ausdrücklich daraufsteht, wird nicht geschrieben.
 *
 * Draufsteht deshalb nur, was den **Lebenszyklus** betrifft: anfangen,
 * aufhören, ein Fenster auf, ein Fenster zu. Das sind die Befehle, deren
 * Fehlen oder Vorhandensein eine Frage beantwortet.
 *
 * Bauart wie die Nachbarn: ohne `electron`-Import, ohne Uhr, reine Funktionen —
 * damit prüfbar, was `sidecar-log.ts` selbst nicht ist (`app.getPath()`).
 */

/**
 * Die Befehle, die mitgeschrieben werden.
 *
 * `start`/`stop` gehören dem Aufnahme-Sidecar, `open`/`close` dem Player,
 * `shutdown` beiden. Bewusst EINE gemeinsame Liste: die Datei ist auch eine
 * gemeinsame, und wer sie liest, sucht den Lebenszyklus, nicht ein Bauteil.
 */
export const LEBENSZYKLUS_OPS: ReadonlySet<string> = new Set([
  'start',
  'stop',
  'shutdown',
  'open',
  'close',
]);

/**
 * Feldnamen, deren **Wert** nie ins Protokoll darf.
 *
 * Verglichen wird kleingeschrieben und als Teilzeichenkette: `token`,
 * `stream_key`, `pushUrl` und alles Ähnliche fallen damit gemeinsam heraus,
 * auch wenn morgen jemand ein Feld hinzufügt, an das hier niemand gedacht hat.
 * Das ist ausdrücklich grosszügig gewählt — ein Feld zu viel unkenntlich zu
 * machen kostet Diagnose, ein Feld zu wenig legt einen Stream-Key im Klartext
 * auf die Platte (Projektregel: niemals Stream-Keys oder Tokens loggen).
 *
 * `url` steht mit drauf, obwohl die meisten URLs harmlos sind: die Push-Adresse
 * trägt den Key als `?token=` oder `?pass=` mit sich (s. `pulse-redact`, die
 * gemeinsame Maskierungs-Kiste aller drei Sidecars), und welche URL welche
 * ist, entscheidet man nicht am Feldnamen.
 */
const GEHEIME_FELDER = ['token', 'secret', 'pass', 'key', 'url', 'credential'];

function istGeheim(feld: string): boolean {
  const f = feld.toLowerCase();
  return GEHEIME_FELDER.some((g) => f.includes(g));
}

/**
 * Eine Kopie ohne Geheimnisse — rekursiv über verschachtelte Objekte und Listen.
 *
 * **Über die Struktur und nicht über den fertigen Text.** `sidecar-log.ts`
 * redigiert zusätzlich per Muster (`redact`), aber ein Muster kennt nur, wonach
 * es sucht: ein Feld mit neuem Namen oder ein Key ohne das erwartete `token=`
 * davor liefe glatt durch. Hier ist die Frage stattdessen „wie heisst das
 * Feld", und die lässt sich beantworten, bevor der Wert überhaupt Text wird.
 * Beide Wege übereinander sind Absicht: der eine fängt, was der andere
 * durchlässt.
 */
export function ohneGeheimnisse(wert: unknown): unknown {
  if (Array.isArray(wert)) return wert.map(ohneGeheimnisse);
  if (wert === null || typeof wert !== 'object') return wert;
  const aus: Record<string, unknown> = {};
  for (const [feld, v] of Object.entries(wert as Record<string, unknown>)) {
    aus[feld] = istGeheim(feld) ? '***' : ohneGeheimnisse(v);
  }
  return aus;
}

/**
 * Die Protokollzeile für einen ausgehenden Befehl — oder `null`, wenn er nicht
 * mitgeschrieben wird.
 *
 * `null` statt eines leeren Strings, damit der Aufrufer den Fall nicht
 * versehentlich als „leere Zeile" schreibt; `logSidecar` würfe sie zwar weg,
 * aber der Unterschied soll an der Aufrufstelle sichtbar sein.
 */
export function befehlZeile(req: Record<string, unknown>): string | null {
  const op = typeof req.op === 'string' ? req.op : null;
  if (!op || !LEBENSZYKLUS_OPS.has(op)) return null;
  return JSON.stringify(ohneGeheimnisse(req));
}
