/**
 * Verdrahtet `postfachQuelle.ts` mit den echten Funktionen — Aufgabe 3 des
 * E6-Auftrags „Nur die Krypto-Schicht" (2026-09-01). `postfachQuelle.ts`
 * selbst bleibt importfrei (s. dort, „Kein eigener Netz-/Krypto-Import") und
 * nimmt `abholen`/`oeffnen` deshalb als Parameter — diese Datei ist die
 * versprochene „eine Zeile" aus ihrem Modulkopf, plus die Antwort auf die
 * Sperren-Frage, die dort ausdruecklich offengelassen ist.
 *
 * **Die Sperren-Frage: dieselbe Konto-Sperre mitbenutzen, nicht eine eigene
 * bauen und nicht in den Abholzyklus haengen.**
 *
 * `gruppenSitzungen.ts` (Modulkopf) legt fest: eingehende Megolm-Sitzungen
 * entstehen und ratchen AUSSCHLIESSLICH im Abholzyklus von
 * `krypto/empfangen.ts`, der als Ganzes unter `mitKontosperre` laeuft (s.
 * dort, „Der ganze Zyklus laeuft unter der Konto-Sperre"). `oeffneGruppen-
 * nachricht` (`krypto/gruppe/empfangen.ts`) ist die Funktion, die genau
 * dieses Ratchen ausloest (`gruppenempfangSichern`, nach jedem
 * Entschluesseln) — jeder Aufruf ausserhalb jenes Zyklus braucht denselben
 * Schutz, sonst ratchen zwei Aufrufer unsynchronisiert an derselben
 * eingehenden Sitzung vorbei (Postfach-Quelle Modulkopf, letzter Absatz).
 *
 * Zwei Wege standen zur Wahl:
 *
 *  1. **Dieselbe Sperre (`mitKontosperre`) um `oeffnen` legen.** Der
 *     Nachzug bleibt ein eigener, unabhaengig laufender Vorgang (eigener
 *     Zeitplan, eigenes Wasserzeichen, KEIN Quittieren — s. Postfach-Quelle-
 *     Modulkopf), tritt aber nie unter derselben Kontosperre erneut ein: er
 *     wird nicht AUS `postfachAbholenUndEntschluesseln` heraus gerufen,
 *     sondern von aussen (ein periodischer Anstoss, verdrahtet in einem
 *     spaeteren Schritt) — Web Locks sind nicht wiedereintrittsfaehig
 *     (`sperren.ts`-Modulkopf, Regel 1), ein verschachtelter Aufruf waere
 *     ein Selbstblock. Ein Aufruf HIER und ein Aufruf im Abholzyklus
 *     serialisieren sich stattdessen ganz gewoehnlich ueber dieselbe
 *     Web-Lock-Warteschlange, tab- UND fensteruebergreifend.
 *  2. **Den Nachzug in den bestehenden Abholzyklus haengen**, statt eine
 *     zweite Stelle daneben zu bauen. Das haette den Vorteil, gar keine
 *     zweite Sperrverwendung zu brauchen — aber der Abholzyklus quittiert
 *     JEDE geoeffnete Zustellung, sobald sie lokal abgelegt ist
 *     (`empfangen.ts::postfachZyklus`). Der Nachzug braucht das
 *     Gegenteil: er darf NICHT quittieren (Postfach-Quelle-Modulkopf,
 *     „Kein zweiter Quittierungspfad" — das Wasserzeichen-Loch, das dieser
 *     Zweig schon zweimal geschlossen hat) und liest denselben Bestand
 *     unabhaengig vom Zeitpunkt des naechsten WS-Weckrufs. Beides in
 *     `postfachZyklus` zu verschraenken haette die Funktion um einen
 *     Sonderfall erweitert, den nur der Ablage-Nachzug braucht, und den
 *     bestehenden, bereits mehrfach bughunt-gehaerteten Weg genau dort
 *     angefasst, wo es am teuersten ist.
 *
 * **Entscheidung: Weg 1.** Er haelt die Zusicherung aus `gruppenSitzungen.ts`
 * ein (dieselbe Sperre schuetzt jede Veraenderung einer eingehenden Sitzung),
 * ohne `postfachZyklus` anzufassen — die Trennung aus dem Postfach-Quelle-
 * Modulkopf (kein Netz-/Krypto-Import, kein Quittieren) bleibt vollstaendig
 * erhalten, nur die Sperre kommt von aussen dazu.
 */
import { postfachApi } from '../api/postfach';
import { serversStore } from '../api/servers.svelte';
import { geraeteKennung } from '../krypto/geraeteKennung';
import { oeffneGruppennachricht } from '../krypto/gruppe/empfangen';
import { mitKontosperre } from '../krypto/sperren';
import { postfachQuelle } from './postfachQuelle';
import type { NachzieherQuelle } from './nachzieher';

function cloudRoute(): { serverId?: string } {
  return { serverId: serversStore.cloudId() };
}

/**
 * Baut die produktive `NachzieherQuelle` fuer den Ablage-Kanal `kanalId`.
 *
 * `abholen` liest ueber die echte Postfach-API (DMs/Gruppen sind
 * cloud-only, s. `api/postfach.ts`-Modulkopf — dieselbe Route wie in
 * `krypto/empfangen.ts`). `oeffnen` ist `oeffneGruppennachricht`, unter der
 * Konto-Sperre — s. Modulkopf fuer die Begruendung.
 */
export function postfachQuelleFuerKanal(kanalId: string): NachzieherQuelle {
  return postfachQuelle(
    kanalId,
    geraeteKennung,
    (deviceKennung) => postfachApi.abholen({ device_pubkey: deviceKennung }, cloudRoute()),
    (zustellung) => mitKontosperre(() => oeffneGruppennachricht(zustellung))
  );
}
