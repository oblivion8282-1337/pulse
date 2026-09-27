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

/** Reine Entscheidung aus der öffentlichen Suspend-/Delete-Liste
 *  (/.well-known/pulse-suspended-instances): steht die gepairte Instanz in
 *  `deleted_instance_ids`, ist das Pairing wertlos — die Registry lehnt die
 *  Creds mit 403 ab (KEIN 401, deshalb greift die Rotations-Erkennung nicht)
 *  und der Container-Start endet sonst stumm in 'something-paused'.
 *  Fail-safe: unlesbare/fehlende Antwort → false (keine Aktion). */
export function classifyDeletedList(instanceId: string, body: unknown): boolean {
  if (body == null || typeof body !== 'object') return false;
  const list = (body as { deleted_instance_ids?: unknown }).deleted_instance_ids;
  return Array.isArray(list) && list.includes(instanceId);
}

/** Ist die gepairte Instanz auf der Cloud gelöscht? Öffentlicher Endpoint —
 *  keine Auth, keine Token-Rotation, keine Nebenwirkung. false bei jedem
 *  Fehler (fail-safe). */
export async function checkInstanceDeleted(
  creds: Pick<BootstrapCreds, 'cloudOrigin' | 'instanceId'>,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  try {
    const resp = await fetchImpl(`${creds.cloudOrigin}/.well-known/pulse-suspended-instances`);
    if (!resp.ok) return false;
    return classifyDeletedList(creds.instanceId, await resp.json());
  } catch {
    return false;
  }
}
