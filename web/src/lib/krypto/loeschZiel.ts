/**
 * Welche LOKALEN Sätze ein Lösch-Frame trifft.
 *
 * Ein Lösch-Frame (`nachrichtNutzlast.ts::baueLoeschNutzlast`) trägt die
 * ID, unter der der ABSENDER die Nachricht kennt. Der Empfänger legt eine
 * empfangene Nachricht aber unter der Zustellungs-ID ab und hält die
 * Absender-ID nur als `krypto_id` daneben (`empfangeneNachricht.ts`, mit
 * Begründung). Wer den Frame-Wert direkt als lokale ID nimmt, findet auf
 * jedem Empfängergerät nichts — so geschehen am 2026-09-02: der Frame kam
 * an, wurde quittiert, und die Nachricht blieb bei der Gegenseite stehen.
 *
 * Getroffen ist ein Satz, wenn er die Frame-ID selbst trägt (eigenes Gerät
 * des Absenders, oder ein aus dem Archiv zurückgeholter Satz) ODER sie als
 * `krypto_id` führt (jedes empfangende Gerät). Beides zugleich kommt bei
 * mehreren Geräten desselben Kontos vor, deshalb eine Liste.
 *
 * Importfrei, damit Nodes eingebauter Testläufer die Datei ohne Bundler
 * prüft (s. CLAUDE.md „Die Falle").
 */

export function lokaleIdsFuerLoeschung(
  frameId: string,
  kandidaten: ReadonlyArray<{ id: string; krypto_id?: string }>
): string[] {
  const treffer = new Set<string>();
  for (const k of kandidaten) {
    if (k.id === frameId || k.krypto_id === frameId) treffer.add(k.id);
  }
  return [...treffer];
}
