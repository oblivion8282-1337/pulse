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
