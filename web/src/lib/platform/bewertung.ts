import { isCapacitorIOS } from './runtime';
import { sollFragen } from './bewertungRegel';
import { sendungZaehlen } from './eigeneSendungen';

/**
 * Die System-Bewertungsfrage, gestellt im richtigen Moment.
 *
 * Nur in der iOS-Hülle — die Frage ist eine App-Store-Sache. Der Zählstand
 * liegt im `localStorage` dieses Geräts; er muss weder genau noch
 * geräteübergreifend sein: er soll nur verhindern, dass ein frischer Nutzer
 * gefragt wird (Begründung in `bewertungRegel.ts`).
 *
 * **Der Zähler selbst liegt seit 2026-10-08 nebenan** (`eigeneSendungen.ts`),
 * weil die Vorerklärung zu Mitteilungen dieselbe Zahl braucht. Im eigenen
 * Schlüssel steht seither NUR `bereitsGefragt` — das ist die einzige
 * Eigenschaft, die zu DIESER Frage gehört; die Zahl daneben mitzuschreiben
 * wäre eine zweite Kopie, die niemand mehr liest. Folge beim Update: ein
 * vorhandener Zählstand im alten Schlüssel wird nicht übernommen, die
 * Bewertungsfrage kommt also einmalig später. Bewusst kein Umzug für eine
 * Zahl, deren Verlust nur die harmlose Richtung kennt.
 *
 * **Die Antwort ist nicht auslesbar.** `requestReview` sagt nie, ob die Frage
 * erschienen ist oder was der Nutzer getan hat. Deshalb wird „bereits
 * gefragt" gesetzt, sobald wir es VERSUCHT haben — die Alternative wäre,
 * es unbegrenzt zu wiederholen.
 */

interface ReviewPlugin {
  anfragen(): Promise<void>;
}

const SCHLUESSEL = 'pulse.bewertung';

function plugin(): ReviewPlugin | null {
  if (typeof window === 'undefined') return null;
  const cap = (window as Window & { Capacitor?: { Plugins?: Record<string, unknown> } })
    .Capacitor;
  return (cap?.Plugins?.ReviewPlugin as ReviewPlugin | undefined) ?? null;
}

function bereitsGefragt(): boolean {
  try {
    const roh = window.localStorage.getItem(SCHLUESSEL);
    if (roh) return (JSON.parse(roh) as { bereitsGefragt?: unknown }).bereitsGefragt === true;
  } catch {
    // Kein oder kaputter Speicher — dann gilt „noch nicht gefragt". Der
    // Schaden wäre eine zweite Frage, nicht eine verlorene.
  }
  return false;
}

function merkeGefragt(): void {
  try {
    window.localStorage.setItem(SCHLUESSEL, JSON.stringify({ bereitsGefragt: true }));
  } catch {
    /* Speicher voll oder abgeschaltet — dann eben nicht. */
  }
}

/**
 * Eine erfolgreich gesendete Nachricht melden. Fragt, sobald die Regel es
 * zulässt. No-op ausserhalb der iOS-Hülle — dort gibt es nichts zu fragen,
 * und der Zähler soll gar nicht erst mitlaufen.
 */
export function sendungGezaehlt(): void {
  // Der Zähler läuft IMMER mit, auch ausserhalb der iOS-Hülle: die
  // Vorerklärung zu Mitteilungen liest ihn ebenfalls, und sie gilt auch für
  // Android. Die Bewertungsfrage selbst bleibt iOS-eigen.
  const gesendet = sendungZaehlen();
  if (!isCapacitorIOS()) return;
  if (!sollFragen({ gesendet, bereitsGefragt: bereitsGefragt() })) return;
  // Erst merken, dann fragen: bricht der Aufruf ab, soll er trotzdem nicht
  // bei der nächsten Nachricht wieder kommen.
  merkeGefragt();
  void plugin()?.anfragen().catch(() => undefined);
}
