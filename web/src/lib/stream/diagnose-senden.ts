/**
 * Versand der Zuschauer-Diagnoseberichte an `POST /api/auth/experimental-logs`.
 *
 * Bewusst getrennt von `diagnose-bericht.ts`: das Sammeln ist reine Rechnerei
 * und ohne Netz testbar, das Senden hat Nebenwirkungen. Zusammen in einer
 * Datei liesse sich das eine nicht ohne das andere prüfen.
 *
 * **Der Versand darf niemals etwas kaputtmachen.** Ein Diagnosebericht ist
 * Beiwerk; wenn er nicht ankommt, hat der Zuschauer trotzdem sein Bild. Jeder
 * Fehler wird deshalb geschluckt und höchstens in die Konsole geschrieben.
 */

import { isElectron } from '$lib/platform/runtime';

import type { DiagnoseBericht } from './diagnose-bericht';
import { loadAll } from './persistence';

const ENDPUNKT = '/api/auth/experimental-logs';

/**
 * Ob gesendet werden darf. **Die wichtigste Funktion in dieser Datei.**
 *
 * Zwei Umgebungen, zwei Antworten:
 *
 * **Desktop-App:** derselbe Schalter wie auf der Senderseite
 * (`uploadDiagnosticLogs`, Tab „Experimental"). Seit 2026-08-06 ist er
 * standardmässig an, deshalb `!== false` und nicht `=== true`: gesendet wird,
 * solange niemand ausdrücklich abgewählt hat. Ein fehlender Schlüssel ist eine
 * frische Installation, keine Ablehnung.
 *
 * **Reiner Browser: NEIN, und das ist eine bewusste Entscheidung, kein
 * Versehen.** Der Schalter sitzt in einem Tab, den es nur in der Desktop-App
 * gibt (`electronOnly`, siehe `SettingsDialog.svelte`) — ein Browser-Zuschauer
 * hat also gar keine Möglichkeit abzuwählen. Dort trotzdem zu senden hiesse,
 * jedem Web-Nutzer stille Telemetrie ohne Abwahl zu verpassen; genau das war
 * der Grund, warum der Upload überhaupt einen eigenen Schalter bekam.
 *
 * **Folge, die benannt gehört:** damit fehlt die Zuschauerseite ausgerechnet
 * bei den Browser-Nutzern, und Pulse ist web-first. Das aufzulösen heisst, den
 * Schalter auch im Browser anzubieten — eine Produktentscheidung, keine
 * technische. Bis dahin deckt der Bericht die Desktop-Zuschauer ab.
 */
export async function darfSenden(): Promise<boolean> {
  if (!isElectron()) return false;
  try {
    return (await loadAll()).uploadDiagnosticLogs !== false;
  } catch {
    // Im Zweifel NICHT senden. Bei einer Einwilligung ist das die einzig
    // vertretbare Richtung des Zweifels.
    return false;
  }
}

/**
 * Umgebungsangaben des Zuschauers für den Kopf des Berichts.
 *
 * Bewusst knapp: `navigator.userAgent` trägt Browser, Fassung und
 * Betriebssystem und ist damit das, was die Diagnose braucht. Weiter zu gehen
 * (Bildschirmgrösse, Spracheinstellung, Schriftenliste) wäre ein Beitrag zum
 * Wiedererkennen des Geräts, nicht zur Fehlersuche — und der Endpunkt ist
 * ohne Anmeldung erreichbar, die Daten also nicht ohnehin schon zugeordnet.
 */
function umgebung(): Record<string, unknown> {
  const u: Record<string, unknown> = {};
  if (typeof navigator !== 'undefined') {
    u.user_agent = navigator.userAgent;
    // `hardwareConcurrency` sagt etwas darüber, ob ein Software-Decoder
    // überhaupt eine Chance hatte — bei einem Zwei-Kern-Gerät ist „ruckelt
    // mit dav1d" keine Überraschung, sondern die Erklärung.
    const kerne = (navigator as { hardwareConcurrency?: number }).hardwareConcurrency;
    if (typeof kerne === 'number') u.kerne = kerne;
  }
  return u;
}

/**
 * Schickt den Bericht ab. Wirft nie.
 *
 * `keepalive` ist hier nicht optional, sondern der Kern der Sache: der Bericht
 * entsteht am Ende der Sitzung, und das fällt oft mit dem Schliessen der
 * Kachel oder des Fensters zusammen. Ohne das Flag bricht der Browser die
 * Anfrage beim Abräumen der Seite ab — es käme ausgerechnet der Bericht nie
 * an, dessen Sitzung ungewöhnlich endete.
 */
export async function sendeDiagnoseBericht(
  bericht: DiagnoseBericht,
  grund: 'stream_end' | 'error',
): Promise<void> {
  try {
    if (!(await darfSenden())) return;
    const koerper = JSON.stringify({
      reason: grund,
      role: 'viewer',
      // Doppelt zum Kopf des Berichts, und das ist Absicht: als eigene Spalte
      // ist der Kanal indiziert und suchbar, im JSON wäre jede Suche danach
      // ein Full-Scan. Er ist der Schlüssel, über den sich dieser Bericht mit
      // der Serversicht verbinden lässt (`scripts/fec-tor-kennzahlen.py`).
      channel_id: String(bericht.kopf.kanal ?? ''),
      system_info: umgebung(),
      report: bericht,
    });
    await fetch(ENDPUNKT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: koerper,
      keepalive: true,
    });
  } catch (e) {
    // Absichtlich nur Konsole: ein fehlgeschlagener Diagnoseversand ist kein
    // Vorfall, den der Nutzer sehen oder der irgendetwas anhalten sollte.
    console.warn('[diagnose] Bericht konnte nicht gesendet werden', e);
  }
}
