import { isCapacitorIOS } from './runtime';
import { sollFragen, type Bewertungsstand } from './bewertungRegel';

/**
 * Die System-Bewertungsfrage, gestellt im richtigen Moment.
 *
 * Nur in der iOS-Hülle — die Frage ist eine App-Store-Sache. Der Zählstand
 * liegt im `localStorage` dieses Geräts; er muss weder genau noch
 * geräteübergreifend sein: er soll nur verhindern, dass ein frischer Nutzer
 * gefragt wird (Begründung in `bewertungRegel.ts`).
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

function lies(): Bewertungsstand {
  try {
    const roh = window.localStorage.getItem(SCHLUESSEL);
    if (roh) {
      const d = JSON.parse(roh) as Partial<Bewertungsstand>;
      return {
        gesendet: typeof d.gesendet === 'number' ? d.gesendet : 0,
        bereitsGefragt: d.bereitsGefragt === true
      };
    }
  } catch {
    // Kein oder kaputter Speicher — von vorn zählen. Der Schaden ist, dass
    // später gefragt wird; das ist die harmlose Richtung.
  }
  return { gesendet: 0, bereitsGefragt: false };
}

function schreib(stand: Bewertungsstand): void {
  try {
    window.localStorage.setItem(SCHLUESSEL, JSON.stringify(stand));
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
  if (!isCapacitorIOS()) return;
  const stand = lies();
  if (stand.bereitsGefragt) return;
  const neu: Bewertungsstand = { ...stand, gesendet: stand.gesendet + 1 };
  if (!sollFragen(neu)) {
    schreib(neu);
    return;
  }
  // Erst merken, dann fragen: bricht der Aufruf ab, soll er trotzdem nicht
  // bei der nächsten Nachricht wieder kommen.
  schreib({ ...neu, bereitsGefragt: true });
  void plugin()?.anfragen().catch(() => undefined);
}
