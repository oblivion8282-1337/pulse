/**
 * Der WebSocket-Probe: prüft in einem Zug, ob die ganze Kette zu einem Server
 * steht — DNS, TLS, Routing durch einen fremden Proxy, **der Upgrade** und der
 * Gateway dahinter.
 *
 * **Warum das überhaupt geht.** `routes/ws.py` ruft `accept()` VOR der
 * Token-Prüfung (mit Absicht: eine Ablehnung vor dem Accept würde Starlette in
 * ein HTTP 403 übersetzen und der Schliesscode ginge verloren). Ein Aufruf mit
 * einem Wegwerf-Token bekommt deshalb einen sauberen Schliesscode zurück, und
 * der trägt die Diagnose. Die Deutung steht nebenan in `verbindungsbefund.ts`.
 *
 * **Warum es ihn braucht.** Ein Proxy ohne `Upgrade`-Header (nginx von Hand,
 * Nginx Proxy Manager ohne den Haken) lässt `/health`, die Vorprüfung und den
 * Cert-Login anstandslos durch — und erst DANACH lädt beim Nutzer nichts mehr.
 * Das ist die häufigste Falle beim Self-Hosten und die einzige, die man vor
 * dem Beitritt sehen kann, ohne sie zu erleben.
 *
 * Das Token ist ein Wegwerfwert und wird nie geloggt (Hausregel gilt auch für
 * offensichtlich wertlose).
 */

import { deuteProbe, type Verbindungsbefund } from './verbindungsbefund';

/** Kurz genug, dass niemand darauf wartet; lang genug für eine träge Leitung. */
const STANDARD_FRIST_MS = 6000;

/**
 * Ein Wegwerf-Token. Der Query-Parameter ist am Gateway PFLICHT
 * (`token: str = Query(...)`) — fehlt er, antwortet FastAPI mit 422, bevor der
 * Endpunkt und damit das `accept()` überhaupt laufen, und der Probe bekäme
 * statt eines Schliesscodes einen abgewiesenen Handschlag zu sehen. Also nie
 * weglassen, auch wenn er inhaltlich nichts trägt.
 */
function wegwerfToken(): string {
  return `probe-${crypto.randomUUID()}`;
}

/**
 * Prüft die Verbindung zu `hostname` (Form `https://host`, wie
 * `normalizeHostname` sie liefert).
 *
 * Wirft nie — jeder Ausgang ist ein Befund.
 */
export function pruefeWebsocket(
  hostname: string,
  timeoutMs: number = STANDARD_FRIST_MS,
): Promise<Verbindungsbefund> {
  // Ohne WebSocket-Umgebung (SSR, exotischer Einbettungsfall) gibt es keine
  // Aussage — und keine Aussage darf nicht wie ein Fehlbefund aussehen.
  if (typeof WebSocket === 'undefined') return Promise.resolve('offen');

  const url = `${hostname.replace(/^http/, 'ws')}/ws?token=${wegwerfToken()}`;

  return new Promise<Verbindungsbefund>((resolve) => {
    let geoeffnet = false;
    let fertig = false;
    let sock: WebSocket;

    const beenden = (befund: Verbindungsbefund) => {
      if (fertig) return;
      fertig = true;
      clearTimeout(timer);
      try {
        sock.close();
      } catch {
        /* schon zu */
      }
      resolve(befund);
    };

    const timer = setTimeout(() => beenden(deuteProbe(geoeffnet, null)), timeoutMs);

    try {
      sock = new WebSocket(url);
    } catch {
      // Schon die URL wurde abgelehnt (gemischter Inhalt, gesperrtes Schema).
      clearTimeout(timer);
      resolve('kein-upgrade');
      return;
    }

    sock.onopen = () => {
      geoeffnet = true;
    };
    // `onerror` trägt im Browser keine Einzelheiten und kommt bei einem
    // gescheiterten Handschlag ohnehin unmittelbar vor `onclose` — gedeutet
    // wird deshalb allein das Schliessen, das immer folgt.
    sock.onclose = (ev) => beenden(deuteProbe(geoeffnet, ev.code));
  });
}
