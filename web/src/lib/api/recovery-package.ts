/**
 * Backend-Client für `/me/recovery-package` (E4, Aufgabe 3:
 * `services/auth/src/dcc_auth/routes_recovery_package.py`).
 *
 * Bearer-Auth wie der Rest von `api/*` (im Gegensatz zu `credentials.ts` kein
 * Cookie-Flow nötig — die Route hängt an `_get_current_user`, das Bearer ODER
 * Cookie akzeptiert). `ciphertext` ist ein für den Server undurchsichtiger
 * Block: base64 des Wiederherstellungs-Päckchens aus
 * `krypto/wiederherstellungsPaeckchen.ts`. Diese Datei weiss nichts über den
 * Inhalt — das ist Sache von `krypto/wiederherstellung.svelte.ts`.
 */

import { request, ApiError } from './client';

export interface RecoveryPackageOut {
  ciphertext: string;
  updated_at: string;
}

/** Ablegen ODER ersetzen — ein Päckchen je Konto, der Server überschreibt.
 *  `password` ist seit der Passwortpflicht (Entscheidung 4.2) Pflicht: das
 *  Päckchen ist die einzige serverseitige Kopie der Archiv-Schlüssel. */
export async function putRecoveryPackage(
  ciphertext: string,
  password: string
): Promise<RecoveryPackageOut> {
  return request<RecoveryPackageOut>('/me/recovery-package', {
    method: 'PUT',
    body: { ciphertext, password },
    endpoint: 'auth',
  });
}

/**
 * Holt das abgelegte Päckchen. Wurde nie eines abgelegt, wirft der Server
 * 404 mit `detail: "no_recovery_package"` — der Aufrufer unterscheidet das
 * über `istKeinPaeckchenFehler(err)`, statt den Statuscode selbst zu prüfen.
 */
export async function getRecoveryPackage(): Promise<RecoveryPackageOut> {
  return request<RecoveryPackageOut>('/me/recovery-package', { endpoint: 'auth' });
}

/** Der Widerruf ohne Neuausstellung — räumt nur auf. Idempotent.
 *  `password` Pflicht (Entscheidung 4.2), wie beim PUT. */
export async function deleteRecoveryPackage(password: string): Promise<void> {
  await request<void>('/me/recovery-package', {
    method: 'DELETE',
    body: { password },
    endpoint: 'auth'
  });
}

/** True für den 404-Fall „kein Päckchen für dieses Konto" — nie für einen
 *  echten Verbindungsfehler (der ist eine `ApiError` mit anderem Status oder
 *  eine `NetworkError`, s. `api/client.ts`). */
export function istKeinPaeckchenFehler(err: unknown): boolean {
  return err instanceof ApiError && err.status === 404;
}
