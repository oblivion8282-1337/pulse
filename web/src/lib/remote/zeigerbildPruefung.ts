/**
 * Die Prüfung des Zeigerbildes, das vom Host über den Gateway hereinkommt —
 * reine Rechnung, ohne Zustand und ohne Nachbarmodule.
 *
 * **Warum getrennt von [`./zeigerform`]:** damit sie prüfbar ist. Der
 * Web-Testläufer (`pnpm test:unit`, Nodes eingebauter) kann eine Datei nur
 * ausführen, wenn sie keine erweiterungslosen Laufzeit-Importe mitschleppt —
 * die löst der Bundler auf, Node nicht. `zeigerform.ts` importiert
 * `./sidecarInput` und ist damit für den Testläufer unerreichbar; dieses Modul
 * importiert **nichts** und bleibt es deshalb. Gleiches Muster wie
 * `zeigerpunkte.rs` im Sidecar, aus demselben Grund.
 *
 * Der zugehörige Test (`web/test/zeigerbild-formen.test.ts`) prüft nicht gegen
 * ausgedachte Beispiele, sondern gegen den Prüfstein `streaming/zeigerbild-formen.json`
 * — die Formen, die der SENDER erzeugt. Warum das der Unterschied ist, steht
 * in der Datei selbst.
 */

/**
 * Das Bild eines Zeigers, den kein Name trägt. Aufbau und Grenzen stehen in
 * `streaming/pulse-player/src/zeigerbild.rs` — hier wird nur geprüft, dass die
 * Felder überhaupt Felder dieser Art sind; was sie bedeuten, deutet der Player.
 *
 * **Es gibt zwei Ausprägungen, und alle Felder ausser `id` gehören zur
 * zweiten:**
 *
 * * **Kurzform** `{id}` — der Host hält das Bild für bereits übertragen. Der
 *   Player greift dann allein über `id` in seinen Vorrat und braucht die Masse
 *   gar nicht (`app/zeigerbau.rs`, `proto.rs` trägt `#[serde(default)]` auf
 *   allen vier Zahlen).
 * * **Vollform** `{id, w, h, hx, hy, daten}` — das Bild selbst.
 *
 * Die Kurzform ist der Regelfall beim Rückwechsel auf einen Zeiger, der eben
 * schon einmal übertragen wurde (Hin- und Herfahren über eine Timeline). Wer
 * die Masse hier zu Pflichtfeldern macht, verwirft sie — und der Steuernde
 * fällt bei jedem solchen Wechsel für bis zu eine Sekunde auf den
 * Standardpfeil. Genau das war bis zum 2026-08-17 der Fall.
 */
export type Zeigerbild = {
  id: string;
  w?: number;
  h?: number;
  hx?: number;
  hy?: number;
  daten?: string;
};

/**
 * Wie lang das Base64-Wort eines Bildes höchstens sein darf.
 *
 * Derselbe Deckel, den der Gateway auf die ganze Nutzlast legt
 * (`_SIGNAL_MAX_DATA_BYTES`, 8 KiB). Der Sidecar hält sich schon daran
 * (`MAX_LAEUFE_BYTE`), aber diese Zahl kommt vom Rechner eines anderen: ohne
 * eigene Prüfung ließe sich über ein selbstgebautes Gegenüber ein beliebig
 * langer String in den IPC zum Hauptprozess schieben.
 */
const MAX_DATEN_ZEICHEN = 8192;

/** Wie lang eine Kennung höchstens ist (der Sender schickt 16 Hex-Zeichen). */
const MAX_KENNUNG_ZEICHEN = 64;

function istZahl(wert: unknown): wert is number {
  return typeof wert === 'number' && Number.isInteger(wert) && wert >= 0 && wert <= 65535;
}

/**
 * Ist das ein Bild, wie es diese Seite weiterreichen darf?
 *
 * **Fail-closed wie beim Namen:** was hier nicht durchkommt, wird nicht etwa
 * halb durchgereicht, sondern gar nicht — der Player setzt dann die Form aus
 * dem Namen. Ein Zeiger ist Rückmeldung, kein Auftrag; im Zweifel lieber der
 * Standardpfeil als ein Bild, dessen Herkunft nicht geprüft ist.
 *
 * **Die Masse gehören zu den Daten, nicht zur Kennung** (s. [`Zeigerbild`]):
 * ohne `daten` wird nur die Kennung verlangt, mit `daten` müssen alle vier
 * Zahlen da sein. Ein halbes Bild — Daten ohne Masse — gäbe es sonst als
 * gültig weiter, und der Player müsste es verwerfen.
 *
 * Nicht geprüft wird, ob die Zahlen *inhaltlich* passen (Masse innerhalb der
 * Grenzen, Haltepunkt im Bild). Das entscheidet der Player beim Entpacken,
 * wo die Grenzen ohnehin stehen — eine vierte Stelle, die dieselben Zahlen
 * kennt, liefe nur auseinander.
 */
export function istBild(wert: unknown): wert is Zeigerbild {
  if (!wert || typeof wert !== 'object') return false;
  const b = wert as Record<string, unknown>;
  if (typeof b.id !== 'string' || !b.id || b.id.length > MAX_KENNUNG_ZEICHEN) return false;
  // Kurzform: der Host hält das Bild für bekannt, der Player greift in seinen
  // Vorrat. Masse brauchte er dafür nicht, also werden sie auch nicht verlangt.
  if (b.daten === undefined) return true;
  if (typeof b.daten !== 'string' || b.daten.length > MAX_DATEN_ZEICHEN) return false;
  return istZahl(b.w) && istZahl(b.h) && istZahl(b.hx) && istZahl(b.hy);
}
