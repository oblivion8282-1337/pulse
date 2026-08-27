/**
 * „Dein Antrag ist durch, der Server will eingerichtet werden" — die eine
 * Rechnung für beide Einstiege in `/app/server`.
 *
 * **Warum ein eigenes Modul.** Der Punkt sass bis 2026-08-27 am Avatar
 * (`UserFooter`) und führte über das Konto-Menü in die Einstellungen. Mit dem
 * Umzug des Self-Host-Bereichs auf eine eigene Route hätte er dort ins Leere
 * gezeigt. Jetzt sitzt er an der Fläche, die er meint — und die gibt es
 * zweimal (Rail am Rechner, Räume-Liste darunter). Zwei Kopien derselben
 * Bedingung wären genau die Sorte Duplikat, die später an einer der beiden
 * Stellen still veraltet.
 *
 * **Nur auf der Cloud.** Die Instanz-Verwaltung lebt dort; auf einem fremden
 * Server kennt die auth-API `/me/instances` gar nicht. Dieselbe Bedingung
 * gatet deshalb auch die Knöpfe selbst (`selfHostEinstiegSichtbar`).
 *
 * Ohne eigene Runen: beide Funktionen lesen die Stores beim AUFRUF, der
 * Aufrufer packt sie in sein `$derived` — dasselbe Muster wie
 * `reiterAuswahl.svelte.ts`.
 */
import { activeServer } from '$lib/stores/active-server.svelte';
import { myAppHostApplications } from '$lib/stores/myAppHostApplications.svelte';
import { myInstanceApplications } from '$lib/stores/myInstanceApplications.svelte';

/** Zeigt dieser Client den Self-Host-Einstieg überhaupt? (Cloud-only) */
export function selfHostEinstiegSichtbar(): boolean {
  return activeServer.current?.isCloud ?? false;
}

/** Roter Punkt am Einstieg: ein eigener Antrag ist freigeschaltet und hier
 *  noch nicht angesehen worden. */
export function selfHostHinweisOffen(): boolean {
  return (
    selfHostEinstiegSichtbar() &&
    (myInstanceApplications.pendingSetup > 0 || myAppHostApplications.pendingSetup > 0)
  );
}
