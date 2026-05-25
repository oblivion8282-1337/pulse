# Backup-Crypto-Entscheidungen (Block 2.B)

## Offene Frage: KDF-Upgrade auf Argon2id?

**Aktuell:** PBKDF2-SHA-256 mit 600 000 Iterationen (OWASP-Cheatsheet 2026).

**Problem:** WebCrypto hat kein natives Argon2id. Die einzige Browser-seitige Option wäre
`argon2-browser` (WASM-Port). Das wäre eine neue Dependency.

**Abwägung:**
- PBKDF2-600k ist vertretbar für Self-Host-Backups (kein kritischer Prod-Use-Case).
- Argon2id-2id ist deutlich resistenter gegen GPU-Brute-Force (Memory-Hardness).
- argon2-browser bringt ~800 KB WASM hinzu; build-pipeline-Einfluss prüfen.
- WebCrypto-API Argon2-Support: kein aktiver WICG-Draft bekannt (Stand 2026-05).

**User-Entscheidung erforderlich:**
Soll argon2-browser als Dependency hinzugefügt werden, um PBKDF2 durch Argon2id
(t=3, m=64 MiB, p=4) zu ersetzen? Auswirkung: ~800 KB WASM-Chunk im Build,
stärkere Brute-Force-Resistenz.

Falls nein: PBKDF2-600k bleibt; ggf. Iterations-Erhöhung auf 1M wenn Benchmarks
das auf Mittelklasse-Devices erlauben (target ≤1s auf Intel Core i5 der 10. Gen).

---

## Aktueller Stand: extractable: false im Standard-Keypair

`keypairStore.generate()` (keypair.svelte.ts Z. 188) ruft `generateKeypair()` ohne
`forBackup: true`. Das Keypair im normalen Flow ist damit `extractable: false`.

**Konsequenz:** Für den Backup-Flow muss entweder:

a) Der Caller einen separaten extractable Key generieren (`generateKeypair({ forBackup: true })`),
   ihn per `crypto.subtle.exportKey('jwk', ...)` exportieren, dann `encryptKeypair()` aufrufen —
   **und** den Standard-Key (non-extractable) separat in IDB behalten.

b) Block 2.E patcht `keypairStore.generate()` so, dass das Keypair mit `extractable: true`
   erzeugt und gespeichert wird. Dann kann der Backup-Flow jederzeit den gespeicherten Key
   exportieren.

**Option (b) ist sauberer** (ein Key-Pair statt zwei), wurde aber bewusst in Block 2.E
verschoben. Bis dahin ist key-backup.svelte.ts vollständig funktionsfähig — der Caller
muss den JWK selbst vor dem Aufruf exportieren.

---

## Manueller Browser-Test (kein Vitest/Node-Test möglich ohne WASM-Polyfill)

Im Browser-DevTools-Konsole auf einer laufenden Pulse-Instanz:

```javascript
import { encryptKeypair, decryptKeypair } from '/src/lib/identity/key-backup.svelte.ts';
// oder nach Build: aus dem Bundle importieren

const priv = { kty: 'OKP', crv: 'Ed25519', /* ... */ };
const pub  = { kty: 'OKP', crv: 'Ed25519', /* ... */ };

const blob = await encryptKeypair(priv, pub, 'test-passwort');
console.log(JSON.stringify(blob, null, 2));

const roundtrip = await decryptKeypair(blob, 'test-passwort');
console.assert(JSON.stringify(roundtrip.privateKey) === JSON.stringify(priv), 'Roundtrip OK');

// Falsches Passwort:
try {
  await decryptKeypair(blob, 'falsches-passwort');
} catch (e) {
  console.assert(e.name === 'BackupDecryptError', 'Korrekte Fehlerklasse');
}
```

Den Roundtrip-Test kann man nach Block 2.E auch mit einem echten generierten Keypair
durchführen (dann `crypto.subtle.exportKey('jwk', keypair.privateKey)` vorher).
