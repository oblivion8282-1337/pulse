/**
 * Prüfsummen fürs Manifest. Läuft in Browser und Node-Testläufer, weil
 * `globalThis.crypto.subtle` in beiden zu Hause ist — ohne Import, damit die
 * Datei nach der Node-Regel prüfbar bleibt.
 */

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
	const verdau = await globalThis.crypto.subtle.digest('SHA-256', bytes as unknown as ArrayBuffer);
	return [...new Uint8Array(verdau)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
