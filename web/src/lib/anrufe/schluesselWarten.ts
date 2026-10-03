/**
 * Warte-Logik fuer den Anruf-Schluessel (E2EE-Anrufe, 2026-09-09) —
 * importfrei (Repo-Muster, s. `krypto/dmSendeSperre.ts`), damit der
 * Node-Testlaeufer sie mit Fake-Uhr pruefen kann.
 *
 * Der Angerufene hat angenommen, aber der Schluessel-Umschlag reist ueber
 * das Postfach (der Initiator verschickt ihn erst nach dem Klingeln) — hier
 * wird pollend gewartet, bis `holen` ihn aus dem Anruf-Store liefert.
 * Fail-closed: Nach der Wartezeit wird `null` geliefert und der Aufrufer
 * bricht den Anruf ab — KEINE stille Rueckfalloption auf unverschluesselt.
 *
 * Zeit (`jetzt`) und Warten (`schlafen`) sind injizierbar; ohne Angabe
 * laufen die echten. `schlafen` bekommt nie mehr als den Rest bis zur
 * Frist — ein traeger Schlafer kann die Frist also nicht ueberziehen.
 */

export const SCHLUESSEL_WARTEZEIT_MS = 10_000;

const ABFRAGE_ABSTAND_MS = 100;

export type WarteAbhaengigkeiten = {
  jetzt?: () => number;
  schlafen?: (ms: number) => Promise<void>;
};

export async function warteAufAnrufSchluessel(
  holen: () => string | null,
  abhaengig: WarteAbhaengigkeiten = {}
): Promise<string | null> {
  const jetzt = abhaengig.jetzt ?? Date.now;
  const schlafen =
    abhaengig.schlafen ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const frist = jetzt() + SCHLUESSEL_WARTEZEIT_MS;
  for (;;) {
    const schluessel = holen();
    if (schluessel !== null && schluessel !== '') return schluessel;
    const rest = frist - jetzt();
    if (rest <= 0) return null;
    await schlafen(Math.min(ABFRAGE_ABSTAND_MS, rest));
  }
}
