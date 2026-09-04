/**
 * „Läuft gerade eine HQ-Übertragung?" — für einen Gast eine Frage, keine
 * Zustellung.
 *
 * Mitglieder erfahren das über den chat-gateway-WebSocket (`stream:events`).
 * Der Gast hat keinen: er hält keine Sitzung, und ein WebSocket für ihn wäre
 * ein zweiter Zugangsweg mit eigener Rechteprüfung. Also fragt er nach.
 *
 * ponytail: Abfrage im festen Takt. Decke: Anfang und Ende einer Übertragung
 * erscheinen beim Gast bis zu `ABFRAGE_MS` verspätet, und jeder Gast kostet
 * eine Anfrage je Takt. Aufstieg: ein schlanker Gast-WebSocket — der kostet
 * einen zweiten Zugangsweg mit eigener Rechteprüfung, und dafür ist die
 * Verzögerung hier zu billig.
 */

import { connectWhep, type WhepSession } from '$lib/stream/whep';
import { gastStreamStand, gastWhepUrl } from './api';

/** Abfragetakt. Fünf Sekunden: kurz genug, dass niemand denkt, es sei kaputt,
 *  lang genug, dass eine Besprechung mit zehn Gästen den Gateway nicht mit
 *  zwei Abfragen je Sekunde beschäftigt. */
export const ABFRAGE_MS = 5000;

class GastStreams {
  /** Nutzer-IDs, die gerade in DEM Kanal des Tickets übertragen. */
  sender = $state<string[]>([]);
  /** Wessen Übertragung der Gast gerade ansieht (Nutzer-ID) — oder null. */
  offen = $state<string | null>(null);
  fehler = $state<string | null>(null);

  #timer: ReturnType<typeof setInterval> | null = null;
  #ticket: string | null = null;
  #sitzung: WhepSession | null = null;

  starten(ticket: string): void {
    this.#ticket = ticket;
    void this.#abfragen();
    this.#timer = setInterval(() => void this.#abfragen(), ABFRAGE_MS);
  }

  beenden(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    this.schliessen();
    this.sender = [];
    this.#ticket = null;
  }

  async #abfragen(): Promise<void> {
    const ticket = this.#ticket;
    if (!ticket) return;
    try {
      const stand = await gastStreamStand(ticket);
      const ids = stand.stream_states.flatMap((s) => s.user_ids ?? []);
      this.sender = ids.map(String);
      // Wer zusieht und dessen Sender aufhört, soll nicht auf ein
      // eingefrorenes Bild starren.
      if (this.offen && !this.sender.includes(this.offen)) this.schliessen();
    } catch {
      // Eine fehlgeschlagene Abfrage ist kein Ereignis: der nächste Takt
      // kommt in fünf Sekunden. Nur die Anzeige stillstehen zu lassen ist
      // ehrlicher, als eine Fehlermeldung über eine laufende Besprechung zu
      // legen.
    }
  }

  /** Die Übertragung eines Mitglieds öffnen und in ``video`` zeigen. */
  async ansehen(userId: string, video: HTMLVideoElement): Promise<void> {
    const ticket = this.#ticket;
    if (!ticket) return;
    this.schliessen();
    this.fehler = null;
    try {
      const { whep_url } = await gastWhepUrl(ticket, userId);
      this.#sitzung = await connectWhep(whep_url, (stream) => {
        video.srcObject = stream;
        void video.play().catch(() => {
          // Autoplay verweigert (kein Nutzerklick auf DIESES Element): das
          // <video> steht dann still da, mit Steuerleiste. Kein Grund zu
          // meckern — der Gast klickt auf Abspielen und es läuft.
        });
      });
      this.offen = userId;
    } catch (e) {
      this.fehler = (e as Error).message || 'fehler';
      this.offen = null;
    }
  }

  schliessen(): void {
    this.#sitzung?.close();
    this.#sitzung = null;
    this.offen = null;
  }
}

export const gastStreams = new GastStreams();
