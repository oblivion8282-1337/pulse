/**
 * Die Anhang-Zeilen eines Verfasser-Feldes — Zustand und Buchfuehrung,
 * ausgezogen aus `MessageInput.svelte` (das ueber der Groessen-Grenze lag)
 * und um die Weiche zwischen Klartext- und verschluesseltem Weg erweitert
 * (Etappe E).
 *
 * **Die Weiche ist der ganze Grund, warum es diese Kiste gibt.** Beide Wege
 * fuellen dieselbe Zeilenform (`PendingAttachment`) und dieselbe
 * Vorschauleiste; sie unterscheiden sich nur darin, WAS hochgeladen wird und
 * WOHIN. Ohne eine gemeinsame Stelle stuende die Fallunterscheidung in der
 * Komponente — und damit an derselben Stelle wie das Zeichnen.
 */

import {
  startUpload,
  cleanupRow,
  type PendingAttachment
} from './upload.svelte';
import { startUploadVerschluesselt } from './uploadVerschluesselt';
import type { AnhangAngabe } from '$lib/krypto/nachrichtNutzlast';

export class VerfasserAnhaenge {
  zeilen = $state<PendingAttachment[]>([]);
  /** Abbruch-Griffe je Zeile. Bewusst KEIN `$state`: sie werden nie gezeigt,
   *  und eine Map im Zustand loeste bei jedem Upload-Fortschritt ein
   *  ueberfluessiges Neuzeichnen aus. */
  #abbrueche = new Map<string, () => void>();

  /** Startet je Datei einen Upload. `verschluesselt` entscheidet den Weg —
   *  einmal, an dieser Stelle. */
  hinzufuegen(kanalId: string, dateien: Iterable<File>, verschluesselt: boolean): void {
    const starte = verschluesselt ? startUploadVerschluesselt : startUpload;
    for (const datei of Array.from(dateien)) {
      const { row, abort } = starte(kanalId, datei, (next) => {
        this.zeilen = this.zeilen.map((z) => (z.localId === next.localId ? next : z));
      });
      this.zeilen = [...this.zeilen, row];
      this.#abbrueche.set(row.localId, abort);
    }
  }

  /** Der X-Knopf an einer Kachel. Bricht ab (was im verschluesselten Weg auch
   *  die lokale Kopie der Bytes mitnimmt) und entfernt die Zeile. */
  entfernen(localId: string): void {
    this.#abbrueche.get(localId)?.();
    this.#abbrueche.delete(localId);
    const zeile = this.zeilen.find((z) => z.localId === localId);
    if (zeile) cleanupRow(zeile);
    this.zeilen = this.zeilen.filter((z) => z.localId !== localId);
  }

  /**
   * Nach dem Abschicken: nur die Vorschau-Objekt-URLs freigeben und die Liste
   * leeren. **Ausdruecklich KEIN `abbrechen`** — die Uploads sind fertig und
   * die Nachricht ist unterwegs; ein Abbruch wuerde im verschluesselten Weg
   * die gerade abgelegten Bytes wieder loeschen und dem Absender sein eigenes
   * Bild nehmen.
   */
  nachDemSenden(): void {
    this.zeilen.forEach(cleanupRow);
    this.zeilen = [];
    this.#abbrueche.clear();
  }

  /** Kanalwechsel oder Unmount: laufende Uploads gehoeren zum verlassenen
   *  Gespraech und werden abgebrochen. */
  alleAbbrechen(): void {
    this.#abbrueche.forEach((abbrechen) => abbrechen());
    this.#abbrueche.clear();
    this.zeilen.forEach(cleanupRow);
    this.zeilen = [];
  }

  get laeuftNoch(): boolean {
    return this.zeilen.some((z) => z.state === 'uploading' || z.state === 'queued');
  }

  /** Kennungen der fertigen Anhaenge — was der Klartext-Weg braucht. */
  get ids(): string[] {
    return this.zeilen
      .filter((z) => z.state === 'done' && z.attachmentId)
      .map((z) => z.attachmentId!);
  }

  /** Angaben der fertigen VERSCHLUESSELTEN Anhaenge — was in die
   *  verschluesselte Nachricht mitmuss. Im Klartext-Weg leer. */
  get anhaenge(): AnhangAngabe[] {
    return this.zeilen
      .filter((z) => z.state === 'done' && z.anhang)
      .map((z) => z.anhang!);
  }
}
