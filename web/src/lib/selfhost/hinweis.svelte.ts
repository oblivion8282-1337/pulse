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
 * **Überall sichtbar, nicht nur auf der Cloud** (seit 2026-08-28). Bis dahin
 * hing der Einstieg an `activeServer.isCloud`, begründet damit, dass „auf einem
 * fremden Server die auth-API `/me/instances` gar nicht kennt". Das stimmt
 * nicht: Der Bereich holt seine Daten über `cookieFetch`, und das geht immer an
 * `AUTH_BASE` — also an die Cloud, weil die Web-App von dort ausgeliefert wird.
 * Welcher Server gerade aktiv ist, spielt dabei keine Rolle (dieselbe Ausnahme
 * gilt in `client.ts::buildUrl` für `endpoint === 'auth'`: immer Cloud-relativ).
 *
 * Die Folge der falschen Annahme war verdreht: Ausgerechnet der KONTO-weite
 * Knopf („meine eigenen Server") war an den aktiven Server gekoppelt, während
 * der server-bezogene Admin-Knopf daneben korrekt überall erschien. Wer auf
 * seinem eigenen Server nach der Verwaltung suchte, fand sie nicht — also genau
 * dort nicht, wo man sie am ehesten sucht.
 *
 * Ohne eigene Runen: `selfHostHinweisOffen` liest ihre Stores beim AUFRUF, der
 * Aufrufer packt das Ergebnis in sein `$derived` — dasselbe Muster wie
 * `reiterAuswahl.svelte.ts`.
 */
import { myAppHostApplications } from '$lib/stores/myAppHostApplications.svelte';
import { myInstanceApplications } from '$lib/stores/myInstanceApplications.svelte';

/** Zeigt dieser Client den Self-Host-Einstieg überhaupt?
 *
 *  Ja — er gehört zum Konto, nicht zum gerade aktiven Server. Die Funktion
 *  bleibt als benannte Stelle stehen, damit die drei Aufrufer eine gemeinsame
 *  Antwort haben, falls je wieder eine Bedingung dazukommt. */
export function selfHostEinstiegSichtbar(): boolean {
  return true;
}

/** Roter Punkt am Einstieg: ein eigener Antrag ist freigeschaltet und hier
 *  noch nicht angesehen worden. */
export function selfHostHinweisOffen(): boolean {
  return (
    selfHostEinstiegSichtbar() &&
    (myInstanceApplications.pendingSetup > 0 || myAppHostApplications.pendingSetup > 0)
  );
}
