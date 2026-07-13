/**
 * Ablöse-Erkennung (Server-App): "Server einrichten" auf einem ANDEREN Gerät
 * rotiert `RegisteredInstance.client_secret` bei jedem Bootstrap-Redeem
 * (services/auth/.../routes_selfhost_bootstrap.py) — dieses Gerät merkt das
 * sonst nie und läuft als Zombie weiter.
 *
 * Check-Endpoint: GET /api/auth/registry/token (Basic clientId:clientSecret)
 * — derselbe Docker-Registry-v2-Token-Realm, den `containerBackendManager.ts`
 * beim Image-Pull ohnehin aufruft (services/auth/.../routes_registry_auth.py).
 * Kein neuer Server-Pfad nötig, keine Nebenwirkung (nur eine SELECT + Argon2-
 * Verify + JWT-Issue, keine DB-Schreibung). 401 ist dort eindeutig: das
 * clientSecret stimmt nicht mehr gegen den aktuellen Hash. 403 (suspendiert)
 * ist bewusst KEIN Ablöse-Beweis — nur 401 zählt, alles andere (Netzwerk,
 * 5xx, 403) ist fail-safe: keine Aktion.
 *
 * Keine Electron-Imports — läuft unverändert unter node:test.
 */

import type { BootstrapCreds } from './pairing';

export type SupersedeVerdict = 'valid' | 'superseded' | 'unknown';

/** Reine Entscheidung aus dem HTTP-Status der Registry-Token-Antwort (kein
 *  Status = Netzwerkfehler/Timeout → null). Volltestbar ohne Netz/Fetch. */
export function classifyRegistryTokenStatus(status: number | null): SupersedeVerdict {
  if (status === 401) return 'superseded';
  if (status != null && status >= 200 && status < 300) return 'valid';
  return 'unknown'; // 403/5xx/Netzwerkfehler — kein eindeutiger Beweis, no-op
}

/** Führt den Check aus und liefert nur den Verdict — main.ts entscheidet,
 *  was bei 'superseded' passiert (Container stoppen, Phase umschalten). */
export async function checkCredsSupersede(
  creds: Pick<BootstrapCreds, 'cloudOrigin' | 'clientId' | 'clientSecret'>,
  fetchImpl: typeof fetch = fetch,
): Promise<SupersedeVerdict> {
  try {
    const basic = Buffer.from(`${creds.clientId}:${creds.clientSecret}`).toString('base64');
    const resp = await fetchImpl(`${creds.cloudOrigin}/api/auth/registry/token`, {
      headers: { Authorization: `Basic ${basic}` },
    });
    return classifyRegistryTokenStatus(resp.status);
  } catch {
    return 'unknown'; // Netzwerkfehler → fail-safe, keine Aktion
  }
}
