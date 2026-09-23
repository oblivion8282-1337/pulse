/**
 * Ver- und Entpackung safeStorage-verschlüsselter Store-Werte
 * (Bughunt 2026-09-23 — `pulse.host.creds` mit `client_secret` +
 * `relay_tunnel_token` und der Legacy-Key `custom_servers` mit alten
 * Stream-Keys lagen bislang als Klartext-JSON im chmod-600-Tresor; der
 * Dateischutz gilt auf Windows/macOS schlicht nicht, `chmod` ist dort ein
 * No-op).
 *
 * **Wrapper-Form:** `{ __pulseGeheim: 1, d: "<base64-Ziphertext>" }` — ein
 * gewöhnlicher Objektwert im JSON-Blob, deshalb für alte Store-Fassungen
 * unsichtbar und ohne Migrationsschema. Die Entschlüsselung passiert
 * transparent in `store.ts` (`storeGet`/`storeGetAll` liefern den Klartext,
 * der Renderer merkt nichts).
 *
 * **Bewusster Fallback:** steht kein OS-Tresor bereit (Linux ohne
 * libsecret/gnome-keyring, z. B. Server-App auf einem Kopf-Host), bleibt der
 * Wert Klartext wie bisher — der chmod-600-Schutz und das Benutzerprofil
 * sind dann die einzige Schranke. Sobald ein Tresor da ist, zieht die
 * Migration beim nächsten Start nach. Beide Formen koexistieren, der Leser
 * unterscheidet über `istGeheimWickel`.
 *
 * Importfrei — der Node-Testläufer prüft Verpackung, Entpackung und die
 * Fehlerfälle ohne Electron (`desktop/electron/store.ts` selbst lässt sich
 * unter Node nicht laden, es fährt die App hoch).
 */

/** Version des Wrappers — für ein künftiges Verfahrenswechsel (safeStorage-
 *  Format ist plattformabhängig und nicht selbst gewählt). */
export const GEHEIM_MARKE = 1;

export type GeheimWickel = { __pulseGeheim: typeof GEHEIM_MARKE; d: string };

export function istGeheimWickel(wert: unknown): wert is GeheimWickel {
  return (
    wert !== null &&
    typeof wert === 'object' &&
    (wert as Record<string, unknown>).__pulseGeheim === GEHEIM_MARKE &&
    typeof (wert as Record<string, unknown>).d === 'string'
  );
}

/** Verschlüsselt einen JSON-String und wickelt ihn als Store-Wert. */
export function wickelGeheimnis(
  json: string,
  verschluessle: (klar: string) => Buffer
): GeheimWickel {
  return { __pulseGeheim: GEHEIM_MARKE, d: verschluessle(json).toString('base64') };
}

/** Entwickelt einen Wrapper zurück in den Originalwert. `null` bei JEDEM
 *  Fehler (OS-Tresor-Schlüssel gewechselt, kaputtes Base64, kein JSON) — der
 *  Aufrufer behandelt das als VERLORENES Geheimnis (Neu-Pairing nötig),
 *  nicht als Crash: ein halber Wert wäre schlimmer als keiner. */
export function entwickleGeheimnis<T = unknown>(
  wickel: GeheimWickel,
  entschluessle: (d: Buffer) => string
): T | null {
  try {
    return JSON.parse(entschluessle(Buffer.from(wickel.d, 'base64'))) as T;
  } catch {
    return null;
  }
}
