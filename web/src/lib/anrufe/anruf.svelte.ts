/**
 * Der Anruf-Zustand (Übergabe P0, Anrufe-Epic C+D) — EINE Sitzung, ein
 * Gleichzeitiger Anruf pro Fenster. Bewusst EIGENE LiveKit-Verbindung
 * neben der Voice-Engine: die Engine ist an Guild-Kanäle gekoppelt
 * (Presence, Bitrate, Resume, Guild-Lookups), ein Anruf hätte davon
 * nichts — der dünne Parallelweg ist weniger riskant als ein dritter
 * Modus in `livekit.svelte.ts`.
 *
 * Ablauf 1:1: `starten` → klingelt (WS an die Gegenseite) → Annahme
 * (`call_angenommen`) → beide verbinden ihren Raum → Auflegen/Ende
 * (`call_ende`) räumt überall ab. 45 s ohne Annahme: der Rufende bricht
 * ab (serverseitig „verpasst“), der Angerufene lehnt automatisch ab.
 */

import { ConnectionState, Room, RoomEvent, Track } from 'livekit-client';
import {
  anrufAnnehmen,
  anrufAblehnen,
  anrufAuflegen,
  anrufStarten,
  getAnrufToken,
  type AnrufArt
} from '$lib/api/anrufe';
import { sounds } from '$lib/sounds/engine';
import { toast } from 'svelte-sonner';
import { formatiereDauer } from '$lib/attachments/aufnahmeKern';
import { m } from '$lib/paraglide/messages.js';
import { anrufSystemzeile, type AnrufZeilenSchluessel } from './systemzeileKern';

const KLINGEL_TIMEOUT_MS = 45_000;

type Rolle = 'ausgehend' | 'eingehend';

type LaufenderAnruf = {
  id: string;
  art: AnrufArt;
  channel_id: string;
  rolle: Rolle;
  gegenstelle: string;
  zustand: 'klingelt' | 'verbunden';
};

class AnrufStore {
  aktiv = $state<LaufenderAnruf | null>(null);
  stumm = $state(false);
  kameranAn = $state(false);
  /** Sekunden seit Annahme — der Ticker der Overlay-UI. */
  dauerSekunden = $state(0);

  #room: Room | null = null;
  #klingelWecker: ReturnType<typeof setTimeout> | null = null;
  #dauerTimer: ReturnType<typeof setInterval> | null = null;
  /** Von `track.attach()` erzeugte Audio-Elemente — beim Abbau entfernen. */
  #ferneStimmen: HTMLMediaElement[] = [];
  /** In einem WS-Handler gesetzte Endes-Info für das gerade Abgebaute. */
  #abbauGen = 0;
  /** Vom WS-Bootstrap angedockte Senke für die Chat-Systemzeile — Injektion
   *  statt Import (`systemzeileSenden.ts`), sonst zirkelt die Sendekette. */
  #zeilenZiel:
    | ((kanalId: string, schluessel: AnrufZeilenSchluessel, dauerSek: number) => void)
    | null = null;
  /** Schon eine Zeile für den LAUFENDEN Anruf hinterlassen? `ende()` und der
   *  lokale Abbau können sich im Wettlauf doppelt melden. */
  #systemzeileErledigt = false;

  get inAnruf(): boolean {
    return this.aktiv !== null;
  }

  /** Vom WS-Bootstrap: dockt die Senke an, die die Systemzeile sendet. */
  zeilenZielSetzen(
    ziel: (kanalId: string, schluessel: AnrufZeilenSchluessel, dauerSek: number) => void
  ): void {
    this.#zeilenZiel = ziel;
  }

  async starten(art: AnrufArt, channelId: string, gegenstelle: string): Promise<void> {
    if (this.aktiv) return;
    // Sync-Platzhalter schließt das Doppelklick-Fenster vor dem await.
    this.aktiv = { id: '', art, channel_id: channelId, rolle: 'ausgehend', gegenstelle, zustand: 'klingelt' };
    this.#systemzeileErledigt = false;
    try {
      const angabe = await anrufStarten(art, channelId);
      this.aktiv = {
        id: angabe.id,
        art,
        channel_id: channelId,
        rolle: 'ausgehend',
        gegenstelle,
        zustand: 'klingelt'
      };
    } catch (e) {
      this.#aufräumen();
      throw e;
    }
    this.#klingelWeckerPlanen();
  }

  /** Eingehender Ruf aus dem WS-Event `call_klingelt` — der Name der
   *  Gegenstelle löst der Handler über den Nutzer-Cache auf. */
  eingehend(
    evt: { call_id: string; art: string; channel_id: string; einleiter_id: string },
    gegenstelle: string
  ): void {
    // Dieselbe Lieferung kann über beide Verbindungen kommen (Hintergrund-
    // Cloud + aktiv) — ein zweiter Lauf desselben call_id darf nichts tun,
    // sonst lehnt der Client sich selbst weg und der Anruf stirbt nach
    // der Annahme (Feldbefund 2026-09-08).
    if (this.aktiv?.id === evt.call_id) return;
    if (this.aktiv) {
      // Wirklich ein anderer Anruf → lehne automatisch ab, statt zu stapeln.
      void anrufAblehnen(evt.call_id).catch(() => {});
      return;
    }
    this.aktiv = {
      id: evt.call_id,
      art: evt.art as AnrufArt,
      channel_id: evt.channel_id,
      rolle: 'eingehend',
      gegenstelle,
      zustand: 'klingelt'
    };
    this.#systemzeileErledigt = false;
    sounds.play('notification.dm');
    this.#klingelWeckerPlanen();
  }

  /** Die Gegenseite hat den Namen ins Overlay getragen (vom Klienten des
   *  Anrufers gesetzt; beim Angerufenen weiß der Store ihn nicht). */
  #setGegenstelle(name: string): void {
    if (this.aktiv) this.aktiv = { ...this.aktiv, gegenstelle: name };
  }

  async annehmen(gegenstelle: string): Promise<void> {
    const anruf = this.aktiv;
    if (!anruf || anruf.rolle !== 'eingehend') return;
    this.#setGegenstelle(gegenstelle);
    this.#klingelWeckerLoeschen();
    try {
      await anrufAnnehmen(anruf.id);
      await this.#verbinden();
    } catch (e) {
      // Annahme fehlgeschlagen (Anruf inzwischen vorbei?) — sauber abräumen.
      toast.error(m.anruf_aktion_fehlgeschlagen(), {
        description: e instanceof Error ? e.message : undefined
      });
      this.#aufräumen();
    }
  }

  async ablehnen(): Promise<void> {
    const anruf = this.aktiv;
    if (!anruf) return;
    this.#klingelWeckerLoeschen();
    if (anruf.rolle === 'eingehend') {
      try {
        await anrufAblehnen(anruf.id);
      } catch {
        // Der Server hat den Anruf vielleicht schon beendet — egal, lokal ist
        // aufgeräumt; das Ende kam oder kommt als `call_ende` ohnehin.
      }
    }
    this.#aufräumen();
  }

  async auflegen(): Promise<void> {
    const anruf = this.aktiv;
    if (!anruf) return;
    // Klingelt der Anruf noch, stuft der Server das Auflegen als „verpasst“
    // ein (routes/anrufe.py) — dieselbe Einstufung für die eigene Zeile.
    this.#systemzeileHinterlassen(
      anruf.zustand === 'klingelt' ? 'verpasst' : 'aufgelegt',
      anruf.zustand === 'klingelt' ? 0 : this.dauerSekunden
    );
    this.#klingelWeckerLoeschen();
    try {
      await anrufAuflegen(anruf.id);
    } catch {
      // Anruf war schon vorbei — der lokale Abbau zählt.
    }
    this.#aufräumen();
  }

  async stummUmschalten(): Promise<void> {
    if (!this.#room) return;
    this.stumm = !this.stumm;
    await this.#room.localParticipant.setMicrophoneEnabled(!this.stumm);
  }

  async kameraUmschalten(): Promise<void> {
    const room = this.#room;
    if (!room) return;
    this.kameranAn = !this.kameranAn;
    await room.localParticipant.setCameraEnabled(this.kameranAn);
  }

  /** Vom WS-Handler: Initiator stoppt Klingeln und verbindet. */
  verbindenNachAnnahme(callId: string): void {
    const anruf = this.aktiv;
    if (!anruf || anruf.id !== callId || anruf.rolle !== 'ausgehend') return;
    this.#klingelWeckerLoeschen();
    void this.#verbinden();
  }

  /** Vom WS-Handler: `call_abgelehnt` beim Rufenden — UI-Info, das Ende
   *  kommt als `call_ende` vom Server (1:1) bzw. als weiteres Klingeln
   *  (Gruppe). */
  gegenstelleAbgelehnt(): void {
    if (this.aktiv?.rolle === 'ausgehend') {
      toast.info(m.anruf_wurde_abgelehnt());
    }
  }

  /** Vom WS-Handler: `call_ende` — überall abbauen, Grund kurz zeigen. */
  ende(callId: string, grund: string, dauerSek: number): void {
    const anruf = this.aktiv;
    if (!anruf || anruf.id !== callId) return;
    this.#systemzeileHinterlassen(grund, dauerSek);
    this.#aufräumen();
    if (anruf.rolle === 'eingehend' && grund === 'verpasst') {
      toast.error(m.anruf_verpasst());
    } else if (grund === 'aufgelegt' && dauerSek > 0) {
      toast.info(m.anruf_beendet_dauer({ dauer: formatiereDauer(dauerSek) }));
    }
  }

  #klingelWeckerPlanen(): void {
    this.#klingelWeckerLoeschen();
    this.#klingelWecker = setTimeout(() => {
      // Sicherheitskipphebel: ein verspäteter Wecker darf nur noch dann
      // handeln, wenn der Anruf IMMER NOCH klingelt — niemals einen
      // verbundenen Anruf totlegen (Feldbefund 2026-09-08).
      if (this.aktiv?.zustand !== 'klingelt') return;
      if (this.aktiv.rolle === 'ausgehend') void this.auflegen();
      else void this.ablehnen();
    }, KLINGEL_TIMEOUT_MS);
  }

  #klingelWeckerLoeschen(): void {
    if (this.#klingelWecker) {
      clearTimeout(this.#klingelWecker);
      this.#klingelWecker = null;
    }
  }

  /** Grund und Dauer sind bekannt → einmalig die Chat-Zeile anstoßen. Ob und
   *  was, rechnet `systemzeileKern.ts` (nur 1:1, nur der Einleiter); ohne
   *  angedockte Senke (Tests, vor dem Bootstrap) bleibt es beim lokalen
   *  Abbau. */
  #systemzeileHinterlassen(grund: string, dauerSek: number): void {
    const anruf = this.aktiv;
    if (!anruf || this.#systemzeileErledigt) return;
    const zeile = anrufSystemzeile(anruf.art, anruf.rolle, grund, dauerSek);
    if (!zeile) return;
    this.#systemzeileErledigt = true;
    this.#zeilenZiel?.(anruf.channel_id, zeile.schluessel, zeile.dauerSek);
  }

  /** LiveKit-Raum betreten — Token von voice-signaling, Room-Name vom Server. */
  async #verbinden(): Promise<void> {
    const anruf = this.aktiv;
    if (!anruf) return;
    const gen = ++this.#abbauGen;
    try {
      const resp = await getAnrufToken(anruf.id);
      if (gen !== this.#abbauGen) return; // inzwischen abgebaut
      const room = new Room();
      this.#room = room;
      room
        .on(RoomEvent.ConnectionStateChanged, (s) => {
          if (s === ConnectionState.Connected) {
            this.aktiv = this.aktiv ? { ...this.aktiv, zustand: 'verbunden' } : null;
            this.#dauerTimerStarten();
          }
        })
        .on(RoomEvent.TrackSubscribed, (track) => {
          // Ferne Stimme hörbar machen — LiveKit liefert Track-Objekte,
          // ohne DOM-Anhang bleibt alles stumm (dasselbe Muster wie die
          // Voice-Engine, nur ohne Gain-/Kompressor-Zubehör).
          if (track.kind === Track.Kind.Audio) {
            const element = track.attach();
            this.#ferneStimmen.push(element);
          }
        })

      await room.connect(resp.ws_url, resp.token);
      if (gen !== this.#abbauGen) {
        void room.disconnect();
        return;
      }
      await room.localParticipant.setMicrophoneEnabled(!this.stumm);
    } catch (e) {
      if (gen !== this.#abbauGen) return;
      toast.error(m.anruf_verbindung_fehlgeschlagen(), {
        description: e instanceof Error ? e.message : undefined
      });
      this.#aufräumen();
    }
  }

  #dauerTimerStarten(): void {
    this.dauerSekunden = 0;
    this.#dauerTimer = setInterval(() => {
      this.dauerSekunden += 1;
    }, 1000);
  }

  /** Lokaler Abbau — Room, Ticker, Zustand. Der Server-POST passiert
   *  getrennt (auflegen/ablehnen), damit Fehler hier nicht hängen bleiben. */
  #aufräumen(): void {
    this.#abbauGen++;
    // Auch der Klingel-Wecker gehört zum Aufräumen — sonst feuert der Wecker
    // eines beendeten Anrufs in den NÄCHSTEN hinein und legt ihn still weg.
    this.#klingelWeckerLoeschen();
    if (this.#dauerTimer) {
      clearInterval(this.#dauerTimer);
      this.#dauerTimer = null;
    }
    const room = this.#room;
    this.#room = null;
    this.stumm = false;
    this.kameranAn = false;
    this.dauerSekunden = 0;
    this.aktiv = null;
    if (room) void room.disconnect();
    // `room.disconnect()` trennt die Tracks, aber die angehängten Elemente
    // bleiben als Medienreste im DOM — hier weg damit.
    for (const element of this.#ferneStimmen) element.remove();
    this.#ferneStimmen = [];
  }
}

export const anrufe = new AnrufStore();
