/**
 * Der Sprachraum eines Gastes — eine eigene, kleine Fassung.
 *
 * **Warum nicht der bestehende `voice`-Store:** der hängt an Konto, Gateway,
 * Einstellungs-Speicher, Rauschfilter, Fernsteuerung, Watch-Party und einem
 * Dutzend Stores, die es auf der Gastseite nicht gibt. Ein Gast-Zweig durch
 * all das hindurch wäre teurer und zerbrechlicher als diese eine Datei, die
 * nur kann, was ein Gast darf: sprechen, Kamera, zuhören, zusehen.
 *
 * Was hier bewusst FEHLT: Bildschirm teilen (ein Gast darf es nicht, das
 * LiveKit-Token lässt die Quelle gar nicht zu), Datenkanal (trägt in Pulse
 * Fernsteuer- und Zeigerdaten), Wiederverbinden über Tage, Geräteumschaltung
 * im laufenden Betrieb.
 */

import {
  ConnectionState,
  Room,
  RoomEvent,
  Track,
  type RemoteParticipant,
  type RemoteTrack,
  type RemoteTrackPublication
} from 'livekit-client';
import { istGastKennung } from '$lib/stores/voicePresence.svelte';
import { gastBeitritt, gastVoiceToken, type GastBeitritt } from './api';

export type GastVideo = {
  /** LiveKit-Identität des Sendenden (`user-<id>` oder `gast-<id>`). */
  identity: string;
  name: string;
  quelle: 'camera' | 'screen';
  /** ``Track`` statt ``RemoteTrack``: eine Veröffentlichung kann auch die
   *  eigene sein. Angezeigt werden hier zwar nur fremde (die eigene Kamera
   *  malt die Kachel selbst), aber der Typ der Sammlung kennt den
   *  Unterschied nicht. */
  track: Track;
};

export type GastTeilnehmer = {
  identity: string;
  name: string;
  istGast: boolean;
  spricht: boolean;
  stumm: boolean;
};

export type GastPhase = 'vorraum' | 'verbinde' | 'drin' | 'weg';

class GastRaum {
  phase = $state<GastPhase>('vorraum');
  fehler = $state<string | null>(null);
  teilnehmer = $state<GastTeilnehmer[]>([]);
  videos = $state<GastVideo[]>([]);
  mikroStumm = $state(false);
  kameraAn = $state(false);
  beitritt = $state<GastBeitritt | null>(null);

  #room: Room | null = null;
  #audioEls = new Map<string, HTMLAudioElement>();
  /** Wird gerufen, wenn die Verbindung endet — egal ob durch Auflegen,
   *  Rauswurf oder Ticket-Ablauf. Die Seite hängt daran das Einstellen der
   *  Stream-Abfrage: ein rausgeworfener Gast fragte sonst weiter im
   *  Fünf-Sekunden-Takt nach und bekäme im Takt ein 403. */
  #beimEnde: (() => void) | null = null;

  beimEnde(rueckruf: (() => void) | null): void {
    this.#beimEnde = rueckruf;
  }

  get ticket(): string | null {
    return this.beitritt?.ticket ?? null;
  }

  /** Den Zustand für einen frischen Besuch zurücksetzen.
   *
   * Der Raum ist ein Modul-Singleton und überlebt damit den Wechsel der
   * Seite. Ohne dieses Zurücksetzen sähe ein Gast, der die Besprechung
   * verlassen hat und den Link erneut öffnet, weiterhin die Endseite —
   * der Zustand ``weg`` bliebe stehen, obwohl er gerade neu ankommt.
   * Dasselbe gilt für eine stehengebliebene Fehlermeldung.
   */
  zuruecksetzen(): void {
    if (this.#room) return; // eine laufende Verbindung nicht wegräumen
    this.phase = 'vorraum';
    this.fehler = null;
    this.beitritt = null;
    this.teilnehmer = [];
    this.videos = [];
    this.mikroStumm = false;
    this.kameraAn = false;
  }

  async beitreten(code: string, name: string): Promise<void> {
    this.phase = 'verbinde';
    this.fehler = null;
    try {
      const b = await gastBeitritt(code, name);
      this.beitritt = b;
      const tok = await gastVoiceToken(b.ticket, b.channel_id);
      const room = new Room({ adaptiveStream: true, dynacast: true });
      this.#room = room;
      this.#verdrahten(room);
      await room.connect(tok.ws_url, tok.token);
      await room.localParticipant.setMicrophoneEnabled(true);
      this.phase = 'drin';
      this.#auffrischen();
    } catch (e) {
      // Der Beitritt ist der einzige Punkt, an dem der Gast überhaupt etwas
      // tun kann. Scheitert er, muss der Grund stehenbleiben — zurück in den
      // Vorraum, mit Text.
      this.fehler = (e as Error).message || 'fehler';
      this.phase = 'vorraum';
      await this.#abbauen();
    }
  }

  async verlassen(): Promise<void> {
    await this.#abbauen();
    this.phase = 'weg';
    this.#beimEnde?.();
  }

  async mikroUmschalten(): Promise<void> {
    const lp = this.#room?.localParticipant;
    if (!lp) return;
    const an = this.mikroStumm; // stumm → jetzt einschalten
    await lp.setMicrophoneEnabled(an);
    this.mikroStumm = !an;
  }

  async kameraUmschalten(): Promise<void> {
    const lp = this.#room?.localParticipant;
    if (!lp) return;
    const neu = !this.kameraAn;
    await lp.setCameraEnabled(neu);
    this.kameraAn = neu;
  }

  async #abbauen(): Promise<void> {
    for (const el of this.#audioEls.values()) el.remove();
    this.#audioEls.clear();
    this.videos = [];
    this.teilnehmer = [];
    const room = this.#room;
    this.#room = null;
    if (room) {
      try {
        await room.disconnect();
      } catch {
        // Beim Verlassen ist ein fehlgeschlagener Abbau folgenlos: die
        // Verbindung stirbt so oder so, und der Gast sieht schon die Endseite.
      }
    }
  }

  #verdrahten(room: Room): void {
    const aktiv = (): boolean => this.#room === room;
    room
      .on(RoomEvent.ParticipantConnected, () => aktiv() && this.#auffrischen())
      .on(RoomEvent.ParticipantDisconnected, () => aktiv() && this.#auffrischen())
      .on(RoomEvent.ActiveSpeakersChanged, () => aktiv() && this.#auffrischen())
      .on(RoomEvent.TrackMuted, () => aktiv() && this.#auffrischen())
      .on(RoomEvent.TrackUnmuted, () => aktiv() && this.#auffrischen())
      .on(RoomEvent.ConnectionStateChanged, (s: ConnectionState) => {
        if (!aktiv()) return;
        if (s === ConnectionState.Disconnected) {
          // Der Server hat die Verbindung beendet — bei einem Gast heisst das
          // fast immer: rausgeworfen oder Ticket abgelaufen. Beides ist
          // endgültig, es gibt nichts, worauf man warten könnte.
          void this.#abbauen();
          this.phase = 'weg';
          this.#beimEnde?.();
        }
      })
      .on(
        RoomEvent.TrackSubscribed,
        (track: RemoteTrack, _pub: RemoteTrackPublication, p: RemoteParticipant) => {
          if (!aktiv()) return;
          if (track.kind === Track.Kind.Audio) {
            const el = track.attach() as HTMLAudioElement;
            el.autoplay = true;
            el.style.display = 'none';
            document.body.appendChild(el);
            this.#audioEls.set(track.sid ?? p.identity, el);
          }
          this.#auffrischen();
        }
      )
      .on(RoomEvent.TrackUnsubscribed, (track: RemoteTrack) => {
        if (!aktiv()) return;
        const sid = track.sid ?? '';
        const el = this.#audioEls.get(sid);
        if (el) {
          el.remove();
          this.#audioEls.delete(sid);
        }
        track.detach().forEach((e) => e.remove());
        this.#auffrischen();
      });
  }

  /** Teilnehmer- und Videoliste aus dem Raum neu bauen.
   *
   * Vollständiger Neuaufbau statt gepflegter Teillisten: die Menge ist bei
   * einer Besprechung klein, und ein Zustand, der nur aus Ereignissen wächst,
   * driftet bei jedem verpassten Ereignis. */
  #auffrischen(): void {
    const room = this.#room;
    if (!room) return;
    const sprecher = new Set(room.activeSpeakers.map((p) => p.identity));
    const liste: GastTeilnehmer[] = [];
    const videos: GastVideo[] = [];
    const alle = [room.localParticipant, ...room.remoteParticipants.values()];
    for (const p of alle) {
      liste.push({
        identity: p.identity,
        name: p.name?.trim() || p.identity,
        istGast: istGastKennung(p.identity),
        spricht: sprecher.has(p.identity),
        stumm: !p.isMicrophoneEnabled
      });
      for (const pub of p.trackPublications.values()) {
        const t = pub.track;
        if (!t || t.kind !== Track.Kind.Video) continue;
        if (p === room.localParticipant) continue; // eigene Kamera zeigt die Kachel selbst
        videos.push({
          identity: p.identity,
          name: p.name?.trim() || p.identity,
          quelle: pub.source === Track.Source.ScreenShare ? 'screen' : 'camera',
          track: t
        });
      }
    }
    this.teilnehmer = liste;
    this.videos = videos;
  }
}

export const gastRaum = new GastRaum();
