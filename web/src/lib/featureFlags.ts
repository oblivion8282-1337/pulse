/**
 * Zentrale Feature-Flags (Build-Zeit-Konstanten).
 *
 * Bewusst KEINE Server-/Env-Steuerung — diese Flags blenden Features aus, die
 * noch nicht end-to-end fertig sind, damit User sie nicht „entdecken" und etwas
 * anfragen, das nicht funktioniert. Zum Wieder-Einschalten: auf `true` setzen.
 */

/**
 * App-Hosting: eigener Pulse-Server auf dem eigenen Gerät.
 *
 * Gehostet wird seit 2026-07-10 ausschließlich in der **separaten Server-App**
 * (`com.howispulse.PulseServer`); der Client zeigt nur noch Antrag + Download.
 * Das frühere In-Client-Hosting ist entfernt: es konnte den Router nicht öffnen
 * (NAT-PMP scheitert an gängigen Heim-Routern) und teilte sich den
 * Container-Namen `pulse-host` mit seinem Nachfolger.
 *
 * Der Schalter blendet Antrag + Download komplett aus, solange kein Paket für
 * die gängigen Systeme existiert (aktuell nur Linux/Flatpak).
 * Self-Hosting (eigener VPS) ist davon UNBERÜHRT.
 */
export const APP_HOSTING_ENABLED = false;

/**
 * Kanäle mit eigener Ablage: verschlüsselte Textkanäle, deren Bytes als Log
 * im eigenen Cloud-Speicher des Owners liegen (Dropbox/Drive/OneDrive/
 * Nextcloud/Sync-Ordner).
 *
 * Konzept: `docs/user-gehostete-kanaele-konzept.md`. Gebaut ist laut
 * Bau-Variante 2 (§6a) nur die krypto-freie Speicher-Hälfte.
 *
 * **AN seit dem 2026-09-01.** Die Bedingung, unter der er zu war, ist
 * eingelöst: der Krypto-Nachzug ist gelandet (Etappe E6). Ein Klartext-Log im
 * privaten Cloud-Konto des Owners wäre der Scan-/Haftungswall aus
 * `docs/user-gehostete-kanaele-analyse.md` (Wand 3) — genau deshalb weist der
 * Server seit B1 einen Klartext-Post in einen Ablage-Kanal ab, und der
 * Nachweis dafür ist eine eigene Prüfung
 * (`tests/e2e/e2e-ablage-kanal.spec.ts`, „die Umkehrung").
 *
 * **Ohne verbundenes Laufwerk gibt es den Kanal-Typ nicht** — der Schalter
 * macht ihn nur wählbar, er ersetzt keine Cloud.
 */
export const ABLAGE_KANAL_ENABLED = true;
