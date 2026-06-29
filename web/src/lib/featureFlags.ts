/**
 * Zentrale Feature-Flags (Build-Zeit-Konstanten).
 *
 * Bewusst KEINE Server-/Env-Steuerung — diese Flags blenden Features aus, die
 * noch nicht end-to-end fertig sind, damit User sie nicht „entdecken" und etwas
 * anfragen, das nicht funktioniert. Zum Wieder-Einschalten: auf `true` setzen.
 */

/**
 * App-Hosting (Pulse-Server lokal aus der Desktop-App heraus hosten, Relay-basiert).
 *
 * AUS, bis die Geräte-Seite wirklich auslieferbar ist. Cloud-Seite (Antrag →
 * Genehmigung → Auto-Instanz → Owner-Stufe → Relay → Pairing) ist fertig + live,
 * aber der lokale Server-Stack läuft heute nur im Dev-Setup (per `uv run` gegen
 * den Quellcode); die Binaries/Container sind in keinem ausgelieferten Build.
 * Richtung/Plan: `docs/superpowers/specs/2026-06-29-apphost-direct-chat-webrtc-datachannel.md`
 * + die Container-All-in-One-Idee (siehe Gespräch). Self-Hosting (eigener VPS)
 * ist davon UNBERÜHRT und bleibt sichtbar.
 */
export const APP_HOSTING_ENABLED = false;
