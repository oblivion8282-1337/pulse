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
import { remoteProtokoll } from './protokoll.svelte';
import { standplatz } from './standplatz.svelte';

/**
 * Darf diese Anfrage ohne Dialog angenommen werden?
 *
 * Fail-closed an jeder Abzweigung — die Prüfung selbst liegt in
 * `standplatz.svelte.ts`; hier steht nur, wo sie gerufen wird.
 */
export function ohneRueckfrage(vonUserId: string | null): boolean {
  // Der Aufrufer merkt sich das Ergebnis als `selbsttaetig`, und daran hängen
  // zwei Dinge: der Zustimmungsdialog bleibt zu (er stünde sonst einen
  // Serverumlauf lang sichtbar da — die Phase bleibt bis zum Echo auf
  // 'incoming' —, und ein Dialog, der von selbst verschwindet, sieht aus wie
  // ein Fehler), und das Protokoll trennt daran die selbsttätige von der
  // bestätigten Übernahme.
  return standplatz.darfOhneRueckfrage(vonUserId);
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
 */
export function uebernahmeBeenden(
  rolle: 'controller' | 'host' | null,
  sessionId: string | null,
): void {
  if (rolle === 'host' && sessionId) void remoteProtokoll.beenden(sessionId);
}
