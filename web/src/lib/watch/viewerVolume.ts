/**
 * Gemerkte Zuschauer-Lautstärke der Watch-Party.
 *
 * Gleicher Gedanke wie `stream/streamVolume.ts` (dort je Streamer): der Regler
 * in der Kachel lebt nur so lange wie die Komponente, ein Kanalwechsel oder das
 * Schliessen der Kachel warf ihn weg. Hier gilt EIN Wert für alle Watch-Partys
 * — anders als beim Streamen gibt es kein Gegenüber, das mal zu laut ist,
 * sondern nur eine Quelle: das Video in der Kachel.
 *
 * Der gemerkte Wert wird beim Start des Players DURCHGESETZT, nicht bloss
 * angezeigt. Das ist der Punkt: YouTube führt im Speicher der youtube.com-
 * Herkunft ein eigenes Gedächtnis über Lautstärke UND Stummschaltung, das über
 * alle Embeds hinweg gilt — auch über die Party hinweg, in der man Host war.
 * Zwei Gedächtnisse ohne Vorrang ergeben genau die Fehler, gegen die das hier
 * gebaut ist. Also: Pulse bestimmt, YouTubes Stand wird beim Start überschrieben.
 *
 * 0 wird mitgemerkt (stumm bleibt stumm), Obergrenze 100 — der YouTube-Embed
 * kennt keine Verstärkung über 100 %, und an sein Audio kommt niemand heran
 * (fremde Herkunft, kein Web-Audio-Griff wie beim WHEP-Player).
 */

const LS_KEY = 'dcc.watchPartyVolume';
const DEBOUNCE_MS = 300;

/** Obergrenze des Reglers in der Zuschauer-Kachel. */
export const WATCH_VOLUME_MAX = 100;
/** Vorgabe, solange nichts gemerkt ist. */
export const DEFAULT_WATCH_VOLUME = 100;

function clamp(v: number): number {
  return Math.min(WATCH_VOLUME_MAX, Math.max(0, v));
}

/** Gemerkte Lautstärke (0..100), oder die Vorgabe. */
export function getWatchVolume(): number {
  if (typeof localStorage === 'undefined') return DEFAULT_WATCH_VOLUME;
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw === null) return DEFAULT_WATCH_VOLUME;
    const v = Number(raw);
    // Auch beim Lesen klemmen — gegen einen von Hand verbogenen Eintrag.
    return Number.isFinite(v) && v >= 0 ? clamp(v) : DEFAULT_WATCH_VOLUME;
  } catch {
    return DEFAULT_WATCH_VOLUME;
  }
}

let timer: ReturnType<typeof setTimeout> | null = null;

/** Lautstärke merken. Entprellt — ein Reglerzug feuert im Dutzend. */
export function setWatchVolume(percent: number): void {
  const v = clamp(percent);
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    try {
      localStorage?.setItem(LS_KEY, String(v));
    } catch {
      /* Speicher voll oder abgeschaltet — dann wird eben nichts gemerkt. */
    }
  }, DEBOUNCE_MS);
}
