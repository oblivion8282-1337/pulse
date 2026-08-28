/**
 * Signiert eine Nutzlast mit dem Geraeteschluessel (Ed25519, `keypairStore`)
 * — der Geraete-Nachweis, den jede Krypto-Route verlangt
 * (`schluessel_nachweis.py::pruefe_geraet`). An einer Stelle, weil
 * `veroeffentlichen.ts`, `senden.ts` und `empfangen.ts` ihn alle brauchen.
 *
 * Kodiert wird mit `utils/base64url.ts` — dieselbe unpadded, URL-sichere
 * Schreibweise, die Cert-Login und WebAuthn schon sprechen und die der Server
 * erwartet (`schluessel_nachweis.py::_b64url_decode` ergaenzt die Polsterung
 * selbst).
 */
import { signChallenge } from '../identity/keypair.svelte';
import type { StoredKeypair } from '../identity/keypair.svelte';
import { base64UrlEncode } from '../utils/base64url';

export async function signiereNutzlast(
  keypair: StoredKeypair,
  nutzlast: Uint8Array
): Promise<string> {
  return base64UrlEncode(await signChallenge(keypair, nutzlast));
}
