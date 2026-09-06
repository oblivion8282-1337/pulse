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

/** Ein ansehbarer Sender. Ein User kann MEHRERE Streams gleichzeitig fahren
 *  (Slots — zwei Monitore als zwei Übertragungen); die Server-Antwort trägt
 *  dafür die ``streams``-Deskriptoren mit. Ohne die (jeder sendet höchstens
 *  einen) läuft alles über Slot 0. */
export type GastSender = {
  userId: string;
  slot: number;
  /** Vom Server gelieferte Beschriftung (z. B. Monitor-Name) — leer, wenn
   *  der Sender nur einen einzigen Stream fährt. */
  label: string;
};

/** Der zusammengesetzte Schlüssel eines Senders — offene Kacheln und die
 *  Button-Auswahl hängen daran, damit zwei Streams desselben Users
 *  unterscheidbar bleiben. */
export function senderSchluessel(s: GastSender): string {
  return `${s.userId}:${s.slot}`;
}

type RohDeskriptor = { user_id?: unknown; slot?: unknown; label?: unknown };

class GastStreams {
  /** Sender, die gerade in DEM Kanal des Tickets übertragen. */
  sender = $state<GastSender[]>([]);
  /** Schlüssel der OFFENEN Kacheln. Mehrere gleichzeitig: eine Kachel je
   *  Stream, wie bei Mitgliedern — wer zwei Bildschirme teilt, wird auch
   *  vom Gast neben- (bzw. unter-)einander gesehen. */
  offen = $state<string[]>([]);
  /** Der MediaStream je offener Kachel — die Kachel hängt ihn per Action an
   *  ihr <video>. Ein Schlüssel steht hier erst, wenn der erste Track kam;
   *  die Kachel zeigt bis dahin Schwarz. */
  strome = $state<Record<string, MediaStream>>({});
  /** Profil-Namen und Avatar-URLs der Mitglieder im Kanal (``user_id`` →
   *  Eintrag). Fehlt ein Eintrag, fällt die Oberfläche auf den LiveKit-Namen
   *  bzw. die Initiale zurück. */
  profile = $state<Record<string, { name: string; avatarUrl: string | null }>>({});
  fehler = $state<string | null>(null);

  /** „Aktualisierung hängt“ — N aufeinanderfolgende Abfragen sind fehl-
   *  geschlagen. Ohne dieses Signal wären „niemand sendet“ und „Abfrage
   *  kaputt“ für den Gast ununterscheidbar. */
  abfrageHaengt = $state(false);

  #frageLaeuft = false;
  #timer: ReturnType<typeof setInterval> | null = null;
  #ticket: string | null = null;
  #sitzungen = new Map<string, WhepSession>();

  starten(ticket: string): void {
    this.#ticket = ticket;
    void this.#abfragen();
    this.#timer = setInterval(() => void this.#abfragen(), ABFRAGE_MS);
  }

  beenden(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    this.alleSchliessen();
    this.sender = [];
    this.profile = {};
    this.abfrageHaengt = false;
    this.fehler = null;
    this.#ticket = null;
  }

  #deskriptoren(raw: unknown): GastSender[] {
    if (!Array.isArray(raw)) return [];
    const aus: GastSender[] = [];
    for (const d of raw as RohDeskriptor[]) {
      const userId = typeof d.user_id === 'string' ? d.user_id : '';
      if (!userId) continue;
      const slot = typeof d.slot === 'number' && Number.isInteger(d.slot) ? d.slot : 0;
      const label = typeof d.label === 'string' && d.label ? d.label : '';
      aus.push({ userId, slot, label });
    }
    return aus;
  }

  async #abfragen(): Promise<void> {
    const ticket = this.#ticket;
    if (!ticket) return;
    // In-flight-Schutz: ein langsamer Durchlauf darf von einem späteren
    // überlappt werden, aber niemals zwei GLEICHZEITIG laufen — sonst kann
    // eine veraltete Antwort eine neuere überschreiben und lebende Kacheln
    // schließen, die real noch senden.
    if (this.#frageLaeuft) return;
    this.#frageLaeuft = true;
    try {
      const stand = await gastStreamStand(ticket);
      this.#frageLaeuftReset();
      const liste: GastSender[] = [];
      for (const zustand of stand.stream_states) {
        const deskriptoren = this.#deskriptoren(zustand.streams);
        if (deskriptoren.length > 0) {
          liste.push(...deskriptoren);
          continue;
        }
        // Kein Slot-Detail (jeder sendet höchstens einen) — Slot-0-Eintrag je
        // User, wie seit jeher.
        for (const uid of zustand.user_ids ?? []) {
          liste.push({ userId: String(uid), slot: 0, label: '' });
        }
      }
      this.sender = liste;
      this.#frageLaeuftReset();
      const naechsteProfile: Record<string, { name: string; avatarUrl: string | null }> = {};
      for (const [uid, p] of Object.entries(stand.teilnehmer ?? {})) {
        naechsteProfile[uid] = { name: p.name, avatarUrl: p.avatar_url };
      }
      this.profile = naechsteProfile;
      // Offene Kacheln ohne lebenden Sender schließen — sonst starrt der Gast
      // auf ein eingefrorenes Bild.
      const gueltig = new Set(liste.map(senderSchluessel));
      for (const key of [...this.offen]) {
        if (!gueltig.has(key)) this.schliessen(key);
      }
      // Wer bereits einen Stream eines Senders offen hat, bekommt NEUE dieses
      // Senders automatisch dazu — Dev startet Monitor 2, während der Gast
      // Monitor 1 ansieht, und beide laufen. Ohne diesen Nachzieh-Mechanismus
      // müsste der Gast binnen des 5-s-Fensters nochmal auf LIVE klicken, um
      // den zweiten zu bekommen.
      for (const s of liste) {
        const key = senderSchluessel(s);
        if (!this.offen.includes(key)) {
          const praefix = `${s.userId}:`;
          if (this.offen.some((k) => k.startsWith(praefix))) {
            void this.ansehen(s.userId, s.slot, false);
          }
        }
      }
    } catch {
      // Eine fehlgeschlagene Abfrage ist kein Ereignis: der nächste Takt
      // kommt in fünf Sekunden. Nur die Anzeige stillstehen zu lassen ist
      // ehrlicher, als eine Fehlermeldung über eine laufende Besprechung zu
      // legen — NACH ein paar Fehlern in Folge darf aber das „hängt“-Signal
      // stehen, sonst ist „niemand sendet“ von „Abfrage kaputt“ nicht
      // unterscheidbar.
      this.#fehlerCount += 1;
      if (this.#fehlerCount >= 3) this.abfrageHaengt = true;
    } finally {
      this.#frageLaeuft = false;
    }
  }

  #fehlerCount = 0;

  #frageLaeuftReset(): void {
    this.#fehlerCount = 0;
    this.abfrageHaengt = false;
  }

  /** Eine weitere Übertragung als eigene Kachel öffnen. ``nutzerAnlass``
   *  entscheidet, ob ein Scheitern als sichtbare Fehlerzeile gilt — das
   *  automatische Nachziehen (neuer Slot eines bereits gesehenen Senders)
   *  scheitert gern einmal während eines Sender-Neustarts und würde sonst
   *  einen Fehler ohne Nutzeranlass zeigen. */
  async ansehen(userId: string, slot: number, nutzerAnlass = true): Promise<void> {
    const ticket = this.#ticket;
    if (!ticket) return;
    const key = senderSchluessel({ userId, slot, label: '' });
    if (this.offen.includes(key) || this.#sitzungen.has(key)) return;
    if (nutzerAnlass) this.fehler = null;
    // Erst die Kachel anmelden, DANN verbinden: der onTrack-Rückruf kann
    // feuern, bevor connectWhep zurückkehrt — ein Strom, der vor seiner
    // Kachel ankommt, wäre sonst verloren.
    this.offen = [...this.offen, key];
    try {
      const { whep_url } = await gastWhepUrl(ticket, userId, slot);
      const sitzung = await connectWhep(whep_url, (stream) => {
        this.strome = { ...this.strome, [key]: stream };
      });
      // Zwei Ausstiegs-Schranken: die Kachel inzwischen geschlossen (X)
      // ODER ein zweites ``ansehen`` für denselben Schlüssel hat längst
      // eine NEUE Sitzung eingetragen — die alte gehört geschlossen, sonst
      // läuft sie als Waise ohne Kachel unbegrenzt weiter.
      if (!this.offen.includes(key) || this.#sitzungen.has(key)) {
        sitzung.close();
        return;
      }
      this.#sitzungen.set(key, sitzung);
    } catch (e) {
      this.#entfernen(key);
      // Lokal, nicht instanzweit: überlappende ``ansehen``-Aufrufe dürfen
      // den Nutzeranlass nicht gegenseitig falsch zuordnen.
      if (nutzerAnlass) {
        this.fehler = (e as Error).message || 'fehler';
      }
    }
  }

  /** Eine Kachel schließen (Verbindung zu + aus der Anzeige raus). */
  schliessen(key: string): void {
    this.#sitzungen.get(key)?.close();
    this.#sitzungen.delete(key);
    this.#entfernen(key);
  }

  alleSchliessen(): void {
    for (const sitzung of this.#sitzungen.values()) sitzung.close();
    this.#sitzungen.clear();
    this.offen = [];
    this.strome = {};
  }

  #entfernen(key: string): void {
    this.offen = this.offen.filter((k) => k !== key);
    const { [key]: _, ...rest } = this.strome;
    this.strome = rest;
  }
}

export const gastStreams = new GastStreams();
