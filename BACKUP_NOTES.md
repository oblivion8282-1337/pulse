# Backup-Crypto-Entscheidungen (Block 2.B)

## Update 2026-05-26: KDF-Switch auf Argon2id (Blob v=2)

**Dependency:** `hash-wasm ^4.12.0` (~50 KB gzipped, WASM-basiert).

**Parameter** (Bitwarden-Standard, identisch mit Backend `argon2-cffi`-Konfiguration):
- `m = 65536 KiB` (64 MiB) — Memory-Hardness, GPU-Resistenz
- `t = 3` — Zeitfaktor (Iterationen über den Speicher)
- `p = 4` — Parallelismus (Threads/Lanes)
- Output: 32 Byte → AES-256-GCM-Key

**Blob-Format v=2:**
```json
{
  "v": 2,
  "kdf": { "name": "Argon2id", "parallelism": 4, "memory_kib": 65536, "iterations": 3, "salt": "<base64>" },
  "cipher": { "name": "AES-GCM", "iv": "<base64>", "ct": "<base64>" }
}
```

**Backwards-Compat:** v=1-Blobs (PBKDF2-SHA-256/600k) werden weiter lesbar gehalten.
`decryptKeypair()` dispatcht auf v, `encryptKeypair()` schreibt ausschließlich v=2.
Keine automatische Rotation nach Decrypt — User wird beim nächsten Backup-Setup
auf v=2 gewechselt.

**Warum Argon2id statt PBKDF2:**
- Memory-Hard: 64 MiB RAM pro Versuch → GPU-/ASIC-Brute-Force ~1000× teurer als PBKDF2.
- Selber Algorithmus wie das Backend-Passwort-Hashing (argon2-cffi t=3/m=64MiB/p=4).
- WebCrypto hat kein natives Argon2id — daher WASM via hash-wasm (~50 KB gzipped,
  erheblich leichter als die ursprünglich diskutierte argon2-browser-Option mit ~800 KB).

---

## Historisch: Offene Frage: KDF-Upgrade auf Argon2id? (erledigt)

~~**Aktuell:** PBKDF2-SHA-256 mit 600 000 Iterationen (OWASP-Cheatsheet 2026).~~

Entschieden für Argon2id via hash-wasm. Siehe Update oben.

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
