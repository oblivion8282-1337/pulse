/**
 * Gerätelokale Kennung für Push-Registrierungen.
 *
 * **Eine Kennung, zwei Registrierungen.** Dasselbe Gerät meldet einen
 * FCM-Token (Nachrichten-Banner) und einen PushKit-Token (Klingeln) an; beide
 * Tabellen haben `(user_id, geraet_id)` als Schlüssel. Würde jede Seite ihre
 * eigene UUID erzeugen, wären es für den Server zwei Geräte — und ein
 * Neuanmelden müsste zwei Zeilen upserten, von denen eine verwaist.
 *
 * Der Schlüsselname ist der historische (`pulse-fcm-geraet-id`): er liegt auf
 * bestehenden Geräten schon im Speicher, und ein neuer Name hiesse, dass
 * jedes Gerät ab dem Update als neues zählt.
 */
const SCHLUESSEL = 'pulse-fcm-geraet-id';

export function pushGeraetId(): string {
  try {
    let id = window.localStorage.getItem(SCHLUESSEL);
    if (!id) {
      id = crypto.randomUUID();
      window.localStorage.setItem(SCHLUESSEL, id);
    }
    return id;
  } catch {
    // Kein Speicher (privates Fenster): eine feste Kennung ist besser als
    // eine zufällige je Start — sonst sammelt der Server Zeilen an.
    return 'geraet-ohne-speicher';
  }
}
