import { request } from '$lib/api/client';
import { darfMelden, type Drosselstand } from './badgeDrossel';

/** Drosselstand dieser Sitzung — was zuletzt gemeldet wurde und wann. */
const stand: Drosselstand = { letzterWert: null, letzteZeit: 0, bereit: false };

/**
 * Den eigenen Ungelesen-Stand an den Server melden, damit er ihn im Push
 * mitschicken kann (`aps.badge`).
 *
 * **Warum der Klient meldet und der Server nicht rechnet:** Bei
 * verschlüsselten DMs — dem Normalweg — kennt der Server die Zahl nicht
 * (Begründung im Modulkopf von `services/chat-gateway/.../badgezaehler.py`).
 * Solange die App wach ist, ist dieser Klient die Wahrheit; der Serverzähler
 * ist nur die Fortschreibung für die Zeit, in der niemand rechnen kann.
 *
 * **Gilt für JEDE Plattform, nicht nur die iOS-Hülle.** Wer am Rechner liest,
 * soll damit die Plakette am Telefon abräumen — dieselbe Erwartung wie bei
 * WhatsApp Web. Der Aufruf geht an den AKTIVEN Server, genau wie die
 * FCM-Token-Meldung daneben (`fcm.ts::meldeAn`): Pushes verschickt der
 * Server, der den Token hält.
 */
export function badgeMelden(wert: number): void {
  const jetzt = Date.now();
  if (!darfMelden(stand, wert, jetzt)) return;
  const vorher = stand.letzterWert;
  stand.letzterWert = wert;
  stand.letzteZeit = jetzt;
  void request<void>('/fcm/badge', { method: 'POST', body: { anzahl: wert } }).catch(
    () => {
      // Fehlgeschlagen (offline, 429, nicht angemeldet): den Merker
      // zurücknehmen, sonst gilt ein nie angekommener Wert als gemeldet und
      // der nächste Durchlauf schweigt über denselben Stand.
      if (stand.letzterWert === wert) stand.letzterWert = vorher;
    }
  );
}

/**
 * Freigabe: Ab jetzt kann dieser Klient seine Zahl verteidigen.
 *
 * Gerufen, sobald der Postfach-Abholweg einer Sitzung durch ist (auch wenn
 * er wegen abgeschalteter Krypto-Schalter gar nichts zu tun hatte) —
 * `ws/handlers/chat.ts::postfachAbholenUndAnzeigen`. Vorher ist die
 * Ungelesen-Rechnung des Klienten noch nicht geladen und seine 0 bedeutet
 * „weiss ich nicht", nicht „alles gelesen" (s. `badgeDrossel.ts`).
 */
export function badgeMeldungFreigeben(): void {
  stand.bereit = true;
}

/** Nach dem Abmelden: der nächste Anmelder soll seinen Stand frisch melden
 *  dürfen, auch wenn er zufällig dieselbe Zahl hat — und erst wieder, wenn
 *  SEINE Lage geladen ist. */
export function badgeMeldungZuruecksetzen(): void {
  stand.letzterWert = null;
  stand.letzteZeit = 0;
  stand.bereit = false;
}
