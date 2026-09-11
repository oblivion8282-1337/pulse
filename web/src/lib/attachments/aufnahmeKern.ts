/**
 * Die Rechnung hinter den Sprachnachrichten (P0.3) — importfrei, damit der
 * eingebaute Testlauf sie ohne SvelteKit-Auflöser und ohne Browser prüft
 * (Repo-Muster: reine Kerne, s. `stores/lesestandKern.ts`).
 */

/** Anhang-Dauer-Grenze für Sprachnachrichten — derselbe Rahmen wie der
 *  Server (DM-Anhang 5 MiB ≈ ~5 min Opus); hart kappen statt 500er-Risiko. */
export const AUFGABE_MAX_SEKUNDEN = 300;

/**
 * Streitet MediaRecorder-Parameter ab („audio/webm;codecs=opus" →
 * „audio/webm"): die Server-Allowlist matcht ohne Parameter-Tail
 * (`routes/attachments.py::_ALLOWED_MIME_RE`).
 */
export function audioMimeBereinigen(mime: string): string {
  const semikolon = mime.indexOf(';');
  return (semikolon === -1 ? mime : mime.slice(0, semikolon)).trim();
}

/** Dateiname für die aufgenommene Sprachnachricht je Container-Format. */
export function aufnahmeDateiname(mime: string): string {
  const basis = 'sprachnachricht';
  if (mime === 'audio/mp4' || mime === 'audio/aac') return `${basis}.m4a`;
  if (mime === 'audio/ogg') return `${basis}.ogg`;
  return `${basis}.webm`;
}

/** Tempo-Zyklus der Wiedergabe: 1 → 1.5 → 2 → 1. */
export function naechstesTempo(aktuell: number): number {
  if (aktuell < 1.5) return 1.5;
  if (aktuell < 2) return 2;
  return 1;
}

/** mm:ss ohne Stunden (Sprachnachrichten sind Minutenware). Unendliche
 *  Dauer (WebM-Blob-Quirk, bevor der Metadaten-Seek lief) → „–:––“. */
export function formatiereDauer(sekunden: number): string {
  if (!Number.isFinite(sekunden)) return '–:––';
  const s = Math.max(0, Math.floor(sekunden));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/**
 * Gemessene Aufnahme-Dauer je Datei. Der WebM-Container von MediaRecorder
 * traegt keine brauchbare Dauer (Chrome meldet `Infinity`, der Seek-Trick
 * im Player aufgeblaehte Werte — sichtbar als „2:39“ auf einer 5-Sekunden-
 * Aufnahme, Testrunde 2026-09-11); die ECHTE Sekundenzahl kennt allein der
 * Aufnahme-Code. WeakMap statt Feld auf `File`: das File bleibt ein
 * plattformsauberes Objekt und der Eintrag stirbt mit dem File.
 */
export const aufnahmeDauerRegister = new WeakMap<File, number>();
