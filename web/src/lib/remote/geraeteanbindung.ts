/**
 * Was eine Fernsteuer-Sitzung mit dem **Gerät** zu tun hat, an dem sie hängt.
 *
 * Zwei Dinge, die beide nur den Host angehen und die beide nicht in die
 * Zustandsmaschine gehören (`session.svelte.ts`) — sie sind Anhängsel an deren
 * Übergängen, nicht Teil des Handschlags:
 *
 * * **Die Dauerfreigabe** beantwortet die Frage „muss hier überhaupt jemand
 *   gefragt werden" (`standplatz.svelte.ts`).
 * * **Das Protokoll** hält fest, wer wann wie lange übernommen hat
 *   (`protokoll.svelte.ts`).
 *
 * Herausgelöst, damit die Zustandsmaschine unter der harten Grössen-Grenze
 * bleibt und — wichtiger — damit die Begründungen dort stehen, wo sie gelten:
 * die Sitzung soll den Handschlag beschreiben, nicht die Geräteverwaltung.
 */

import { gegenstelle } from './gegenstelle';
import { deviceStore } from '$lib/devices/store.svelte';
import { herkunftsVerbindung, sendenAuf } from './draht';
import { dispatchingServerId } from '$lib/ws/gateway-connection';
import { geraeteAnmeldung } from '$lib/devices/anmeldung.svelte';
import { wiederEinschlafen } from '$lib/devices/wecken';
import { remoteProtokoll } from './protokoll.svelte';
import { standplatz } from './standplatz.svelte';

/**
 * Welches Standplatz-Gerät steht in diesem Kanal und gehört diesem Nutzer?
 *
 * Der Steuernde hängt die Kennung an seine Anfrage, damit sie beim richtigen
 * Rechner landet. `null` heisst „ein Mensch, kein Gerät" — dann bleibt alles
 * wie bisher.
 */
export function geraetFuerAnfrage(channelId: string, hostUserId: string): string | null {
  return deviceStore.byChannelOwner(channelId, hostUserId)?.id ?? null;
}

/**
 * Eine Anfrage ablehnen, die ein ANDERES Gerät meint.
 *
 * **Warum das nötig ist** (Bughunt 2026-08-16): die Einladung geht an alle
 * Fenster des Hosts — also auch an seinen Laptop, wenn dort dasselbe Konto
 * angemeldet ist. Stimmte dort jemand zu, sähe der Steuernde den Werkstatt-PC
 * und bediente den Laptop. Meist fielen die Eingaben dort als „unbekannter
 * Platz" durch, aber eben nicht zwingend — und „meist" ist bei fremder
 * Tastatur auf einem fremden Rechner die falsche Zusage.
 *
 * Ohne Kennung in der Anfrage gilt sie für jeden: eine Anfrage an einen
 * MENSCHEN nennt kein Gerät, und die soll unverändert durchgehen.
 *
 * Liefert `true`, wenn abgelehnt wurde — der Aufrufer hört dann auf.
 */
export function fremdesGeraetAblehnen(sessionId: string, deviceId?: string): boolean {
  if (!deviceId) return false;
  if (geraeteAnmeldung.fuerServer(dispatchingServerId())?.deviceId === deviceId) return false;
  // **Schweigen, nicht ablehnen** (Bughunt 2026-08-16). Der Gateway nimmt die
  // ERSTE Antwort und sperrt den Anfragenden nach einer Ablehnung kurz
  // (`remote_note_refused`, 4055). Eine Ablehnung von hier wäre ein Wettlauf
  // gegen das gemeinte Gerät: der Besitzer hat neben dem Werkstatt-PC einen
  // Browser-Tab offen, beide bekommen die Einladung, und wer gewinnt,
  // entschiede die Netzlaufzeit — genau in der Lage, für die dieses Feature
  // gebaut ist. Antwortet niemand, verfällt die Anfrage nach der Frist; das
  // ist langsamer als eine Absage, aber es ist nie die falsche.
  return true;
}

/**
 * Darf diese Anfrage ohne Dialog angenommen werden?
 *
 * Fail-closed an jeder Abzweigung — die Prüfung selbst liegt in
 * `standplatz.svelte.ts`; hier steht nur, wo sie gerufen wird.
 *
 * **Seit 2026-08-20 reicht das nur noch durch.** Wer diese Anfrage deckt, weiss
 * seit dem Server-Umzug der Freigabeliste (`device_grants`) allein der
 * Gateway — er kennt Rollen und Kanalmitgliedschaft, der Client nicht. Das
 * Ergebnis kommt als Feld `freigabe` am `remote_request`-Rahmen herein
 * (`ws/handlers/remote.ts`); der Hauptschalter am Gerät bleibt trotzdem hier,
 * nicht auf dem Server (Begründung im Datei-Kopf von `standplatz.svelte.ts`).
 */
export function ohneRueckfrage(freigabeVomServer: boolean): boolean {
  // Der Aufrufer merkt sich das Ergebnis als `selbsttaetig`, und daran hängen
  // zwei Dinge: der Zustimmungsdialog bleibt zu (er stünde sonst einen
  // Serverumlauf lang sichtbar da — die Phase bleibt bis zum Echo auf
  // 'incoming' —, und ein Dialog, der von selbst verschwindet, sieht aus wie
  // ein Fehler), und das Protokoll trennt daran die selbsttätige von der
  // bestätigten Übernahme.
  return standplatz.selbsttaetigZustimmen(freigabeVomServer);
}

/**
 * Der Besitzer hat abgelehnt — der geweckte Rechner hört sofort auf.
 *
 * Getrennt von [`uebernahmeBeenden`], weil die Anlässe verschieden sind: dort
 * endet eine Sitzung (und nur eine zustande gekommene schickt das Gerät
 * schlafen), hier gab es nie eine. Ohne diesen Weg fiele die Ablehnung an die
 * Nachlauf-Wache (`devices/wecken.ts`, 90 s) — die ist als Netz für Fälle ohne
 * Entscheidung gedacht, nicht als Wartezeit nach einem Nein.
 *
 * Nur auf einem eingetragenen Gerät und nur für die Ströme, die ein Weckruf
 * gestartet hat; was der Besitzer von Hand gestartet hat, bleibt unangetastet.
 */
export async function abgelehntEingeschlafen(): Promise<void> {
  if (geraeteAnmeldung.eintragungen.length === 0) return;
  await wiederEinschlafen('Anfrage vom Besitzer abgelehnt');
}

/**
 * Eine Übernahme beginnt.
 *
 * **Nur der Host führt Protokoll**: es beantwortet „wer hat MEINEN Rechner
 * übernommen". Beim Steuernden gäbe es dieselbe Zeile mit umgekehrtem
 * Vorzeichen, und die gehört nicht in dieselbe Liste.
 *
 * `selbsttaetig` ist der ganze Punkt der Aufzeichnung: eine Übernahme, der
 * niemand zugesehen hat, muss sich von einer bestätigten unterscheiden lassen.
 */
export function uebernahmeBeginnen(
  rolle: 'controller' | 'host' | null,
  sessionId: string,
  peerUserId: string | null,
  selbsttaetig: boolean,
): void {
  if (rolle !== 'host') return;
  void remoteProtokoll.beginnen(
    sessionId,
    peerUserId ?? '',
    gegenstelle(peerUserId).anzeige,
    selbsttaetig,
  );
}

/**
 * Eine Übernahme endet.
 *
 * Folgenlos für Anfragen, die es nie bis zur Zustimmung geschafft haben — die
 * haben gar keinen Eintrag. Deshalb darf dieser Ruf am einzigen Ausgang der
 * Sitzung hängen, ohne dort nach dem Zustand zu fragen.
 *
 * `zustandeGekommen` sagt, ob es überhaupt eine Übernahme WAR (Phase `active`).
 * Nur davon hängt das Einschlafen ab (Bughunt 2026-08-16): der Ruf sitzt am
 * einzigen Ausgang, und der wird auch von einer abgelehnten oder abgelaufenen
 * Anfrage genommen. Das Gerät legte sich dann schlafen, obwohl der Weckruf
 * gerade erst gewirkt hatte und womöglich schon jemand zusieht — der
 * Anfragende sah sein Bild verschwinden, kaum dass es da war.
 */
export function uebernahmeBeenden(
  rolle: 'controller' | 'host' | null,
  sessionId: string | null,
  zustandeGekommen: boolean,
): void {
  if (rolle !== 'host') return;
  if (sessionId) void remoteProtokoll.beenden(sessionId);
  if (!zustandeGekommen) return;
  // **Und das Gerät schläft wieder ein.** Ein einmal geweckter Rechner überträgt
  // sonst für immer weiter und verbraucht genau das, was „erst auf Abruf"
  // einsparen sollte. Nur auf einem eingetragenen Gerät und nur für die
  // Ströme, die ein Weckruf gestartet hat (`devices/wecken.ts`).
  if (geraeteAnmeldung.eintragungen.length > 0) void wiederEinschlafen('Fernsteuerung beendet');
}
