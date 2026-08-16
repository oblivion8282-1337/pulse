/**
 * Fernsteuerung — die Fehlercodes des Gateways in Sätze übersetzt.
 *
 * Eigene Datei, weil der Session-Store (`session.svelte.ts`) die
 * Zustandsmaschine trägt und sonst gegen die Größen-Grenze läuft; hier steht
 * reine Textarbeit ohne Zustand.
 *
 * Die Codes vergibt `services/chat-gateway/.../ws_remote_handlers.py`
 * (4050–4056) — beim Ändern dort beide Seiten anfassen. **Seit 2026-08-16
 * kommt 4056 auch aus `ws_device_handlers.py`**: der Weckruf hat dieselbe
 * Zwei-Sekunden-Bremse bekommen wie die Anfrage, und er meldet sie mit
 * demselben Code, weil der Nutzer keinen Unterschied sieht — er hat zu schnell
 * geklickt.
 */

/**
 * Dieselbe Lage aus zwei Quellen: die eigene Frist im Store und das
 * `remote_ended`(timeout) des Gateways. Deshalb einmal benannt — sonst bekommt
 * der Nutzer je nachdem, wer zuerst zuschlägt, einen anderen Wortlaut, sobald
 * jemand nur eine der beiden Stellen umformuliert.
 */
export const KEINE_ANTWORT = 'Der Host hat nicht geantwortet.';

/** Consent-/Erreichbarkeits-Fehlercodes (s. `ws_remote_handlers.py`). */
export function remoteErrorMessage(code: number, fallback: string): string {
  switch (code) {
    case 4051:
      return 'Keine Berechtigung für Fernsteuerung in diesem Kanal.';
    case 4052:
      return 'Der Host ist gerade nicht erreichbar.';
    case 4053:
      // Die Sitzung/Anfrage gibt es nicht mehr — beim Host der Fall, wenn er
      // erst antwortet, nachdem der Gateway die Anfrage hat verfallen lassen.
      return 'Die Anfrage ist nicht mehr gültig.';
    case 4054:
      return 'Der Host hat bereits eine aktive Fernsteuerungs-Sitzung.';
    case 4055: {
      // Sperrfrist nach Absage/Aussitzen. Der Server schreibt die Restzeit in
      // den englischen Text ("retry in 12s") — die ist die einzige Auskunft,
      // die dem Wartenden hilft, deshalb wird sie herausgelesen statt mit dem
      // Text verworfen. Fehlt sie (anderer Wortlaut), bleibt die Aussage wahr.
      const restS = Number(/(\d+)\s*s/.exec(fallback)?.[1]);
      if (!Number.isFinite(restS)) return 'Der Host hat gerade abgelehnt. Bitte kurz warten.';
      // Singular/Plural von Hand — die Sperrfrist läuft auf 1 herunter, und
      // „Erneut möglich in 1 Sekunden" ist genau der Satz, den der Nutzer am
      // Ende jeder Wartezeit zu lesen bekäme.
      const einheit = restS === 1 ? 'Sekunde' : 'Sekunden';
      return `Der Host hat gerade abgelehnt. Erneut möglich in ${restS} ${einheit}.`;
    }
    case 4056:
      // Mindestpause zwischen zwei Anfragen, je Verbindung. Trifft nur, wer
      // schneller klickt als ein Mensch klicken kann — die Restzeit ist
      // deshalb nicht der Rede wert, anders als bei der Sperrfrist oben.
      return 'Zu schnell hintereinander angefragt. Bitte einen Moment warten.';
    default:
      return fallback || 'Fernsteuerung fehlgeschlagen.';
  }
}
