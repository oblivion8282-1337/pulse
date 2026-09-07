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
 * **Und nur, wenn der Absender des Umschlags auch der Autor des Satzes ist.**
 * Ein Lösch-Frame trägt eine ID und sonst nichts; wer die ID kennt, kann ihn
 * bauen. Der Gesprächspartner kennt sie immer — er hat sie mit der Nachricht
 * bekommen und legt sie als `krypto_id` ab, während sie beim Verfasser die
 * lokale `id` IST. Ohne diesen Vergleich löscht ein angepasster Klient der
 * Gegenseite die eigenen Nachrichten des Empfängers auf dessen Gerät, samt
 * Grabstein im Archiv — und ein Archiv-Grabstein lässt sich nicht
 * zurücknehmen.
 *
 * Importfrei, damit Nodes eingebauter Testläufer die Datei ohne Bundler
 * prüft (s. CLAUDE.md „Die Falle").
 */

export function lokaleIdsFuerLoeschung(
  frameId: string,
  kandidaten: ReadonlyArray<{ id: string; krypto_id?: string; author_id?: string }>,
  absenderUserId: string
): string[] {
  const treffer = new Set<string>();
  for (const k of kandidaten) {
    if (k.id !== frameId && k.krypto_id !== frameId) continue;
    // Ohne bekannten Autor wird nicht gelöscht: fehlt das Feld, ist der Satz
    // nicht zuzuordnen, und „im Zweifel löschen" ist bei einem Vorgang ohne
    // Rückweg die falsche Richtung.
    if (k.author_id !== absenderUserId) continue;
    treffer.add(k.id);
  }
  return [...treffer];
}
