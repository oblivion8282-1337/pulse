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
 * Bau-Variante 2 (§6a) nur die krypto-freie Speicher-Hälfte
 * (`src/lib/ablage/` — Log-Format, Adapter für Sync-Ordner, WebDAV,
 * Dropbox/OneDrive/Google Drive (App-Folder-OAuth) und S3, Schreiber, Leser,
 * Nachzieher). **Der Schalter
 * bleibt zu, bis der Krypto-Nachzug gelandet ist:** ein Klartext-Log im
 * privaten Cloud-Konto des Owners ist kein Produktzustand, sondern genau der
 * Scan-/Haftungswall aus `docs/user-gehostete-kanaele-analyse.md` (Wand 3).
 */
export const ABLAGE_KANAL_ENABLED = false;
