/**
 * Was der Klient über die eigene Identität weiss.
 *
 * Bis zum 2026-08-28 lag hier das Gerätezertifikat samt Ed25519-Schlüsselpaar,
 * Ausstellung und Rotation. Beides ist ersatzlos entfallen: Die Anmeldung an
 * einem fremden Server holt sich im Moment der Nutzung ein kurzlebiges Ticket
 * bei der Cloud (`api/server-ticket.ts`). Im Browser liegt nichts Langlebiges
 * mehr — und damit auch nichts, das verlorengehen oder zwischen zwei Browsern
 * in Streit geraten kann.
 *
 * Übrig ist das Profil-Statement: Name und Bild, die ein Server anzeigen
 * können muss. Das ist eine andere Sache als die Anmeldung.
 */

export { profileStatementStore, parseStatementClaims } from './profile-statement.svelte';
export type { ProfileStatement } from './profile-statement.svelte';
export { startProfileRefresh, stopProfileRefresh, forceProfileRefresh } from './profile-refresh.svelte';
