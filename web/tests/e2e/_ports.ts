/**
 * Ports der E2E-Suite — bewusst NEBEN dem Dev-Stack, nicht auf ihm.
 *
 * Bis 2026-07-30 fuhr die Suite ihre eigenen auth/chat-gateway auf **8001/8002**
 * und liess sich von Playwright den Vite auf **5173** teilen — also exakt auf den
 * Ports des laufenden Dev-Stacks. Das erzwang `dev-down.fish` vor jedem Lauf.
 *
 * Der Grund, warum das nicht einfach ein „dann nimm halt andere Ports" war,
 * steckt im Vite: `reuseExistingServer` haette den **Dev**-Vite uebernommen, und
 * dessen Proxy zeigt auf die **Dev**-Dienste. Die Suite haette dann gegen die
 * Dev-Datenbank `dcc` getestet statt gegen `dcc_test` — und zwar lautlos, weil
 * alles ansonsten normal aussieht. Genau davor schuetzte der harte Abbruch in
 * `_globalSetup.ts`. Verschoben werden mussten deshalb ALLE drei Ports
 * gemeinsam, sonst tauscht man einen sichtbaren Fehler gegen einen stillen.
 *
 * Die Werte sind Vorgaben, keine Konstanten: wer mehrere Arbeitskopien parallel
 * faehrt, verschiebt die Gruppe ueber die Umgebungsvariablen.
 */

const port = (name: string, fallback: number): number => {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  // Lautes Scheitern bei Tippfehlern, kein stiller Rückfall: wer die Gruppe
  // verschiebt und sich vertippt, bekäme sonst die Vorgabe und damit genau die
  // Kollision zurück, gegen die diese Datei existiert.
  if (!Number.isInteger(n)) throw new Error(`${name}="${raw}" ist keine Portnummer.`);
  return n;
};

export const E2E_AUTH_PORT = port('PULSE_E2E_AUTH_PORT', 8101);
export const E2E_CHAT_PORT = port('PULSE_E2E_CHAT_PORT', 8102);
export const E2E_WEB_PORT = port('PULSE_E2E_WEB_PORT', 5273);

/**
 * Es läuft KEIN voice-signaling unter Test — die Suite startet nur auth und
 * chat-gateway. Der Port zeigt deshalb bewusst ins Leere: bliebe er
 * unkonfiguriert, liefe `/api/voice` aus dem Test-Vite in den **Dev**-Stack auf
 * 8003. Heute fällt das niemandem auf (keine Spec fährt echtes Voice), aber es
 * ist dieselbe Klasse „Testverkehr erreicht Dev-Infrastruktur", die diese Datei
 * beseitigen soll. So scheitert der erste Test, der es versucht, sofort und
 * sichtbar statt still gegen fremde Dienste zu laufen.
 */
export const E2E_VOICE_PORT = port('PULSE_E2E_VOICE_PORT', 8103);

export const E2E_BASE_URL = `http://127.0.0.1:${E2E_WEB_PORT}`;
