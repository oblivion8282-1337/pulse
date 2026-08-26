/**
 * Die Rechnung „welcher Kanal steht gerade auf dem Schirm".
 *
 * **Das Modul hat bewusst KEINEN Laufzeit-Import** — dieselbe Auflage wie bei
 * `tabs.ts`: es wird von Nodes eingebautem Läufer geprüft (`pnpm test:unit`),
 * und der löst die erweiterungslosen Importe der Web-Quellen nicht auf.
 *
 * **Warum überhaupt eigenes Modul:** die Layout-Regel des Handys braucht zwei
 * Auskünfte, die vorher beide fehlten und jede für sich eine Sackgasse
 * erzeugten.
 *
 * 1. *Welcher* Kanal — nicht bloss „irgendein Kanal-Bildschirm". Die
 *    Querformat-Regel prüfte nur das Muster des Pfades und verglich ihn nie
 *    mit dem Kanal, in dem der Stream läuft. Wer in Sprachkanal A einen Stream
 *    offen hatte und dann Textkanal B öffnete, verlor beim Kippen gleichzeitig
 *    Bereichsleiste, Sprach-Dock, Community-Leiste und Kanalliste — auf dem
 *    Textchat blieb nur die System-Zurückgeste.
 * 2. *Welche Art* Kanal. Die Ausnahme „auf dem Kanal-Bildschirm bleibt die
 *    Bereichsleiste stehen" ist mit dem Sprach-/Stream-Bildschirm begründet
 *    (laufender Zustand statt Durchgang), traf aber jeden Textkanal mit — dort
 *    standen dann Zurück-Pfeil und Vier-Reiter-Leiste gleichzeitig da, zwei
 *    Aussagen darüber, wo man ist, und rund 60 px weniger für den Verfasser.
 */

/** `/app/guilds/<guildId>/channels/<channelId>` — und sonst nichts. */
const KANAL_PFAD = /^\/app\/guilds\/([^/]+)\/channels\/([^/]+)$/;

export interface KanalAufSchirm {
  readonly guildId: string;
  readonly channelId: string;
}

/**
 * Zerlegt den Pfad in Community und Kanal, oder `null`, wenn gerade gar kein
 * Kanal-Bildschirm offen ist. Nachlaufende Schrägstriche werden abgeschnitten,
 * damit `/…/channels/7/` dieselbe Antwort gibt wie `/…/channels/7`.
 */
export function kanalAusPfad(pfad: string): KanalAufSchirm | null {
  let p = pfad;
  while (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);
  const m = KANAL_PFAD.exec(p);
  return m ? { guildId: m[1], channelId: m[2] } : null;
}

/**
 * Steht auf dem Schirm genau der Kanal, in dem gerade gesprochen wird?
 *
 * `null`/`undefined` für `sprachKanalId` heisst „in keinem Sprachkanal" und
 * ist damit immer `false` — nicht etwa „egal welcher".
 */
export function istAktiverSprachKanal(
  pfad: string,
  sprachKanalId: string | null | undefined
): boolean {
  if (!sprachKanalId) return false;
  return kanalAusPfad(pfad)?.channelId === sprachKanalId;
}
