/**
 * Die Medienseite des Anruf-Zustands: was die Oberfläche vom laufenden Raum
 * zeigt (Mikrofon, Kamera, Ausgabe, Dauer, Verschlüsselung), die Knöpfe
 * dafür, das Betreten des Raums samt Anruf-Schlüssel, und die Übernahme
 * eines nativen Gesprächs nach einem Reload. Die Signalisierung
 * (`anruf.svelte.ts`) erbt davon — die Oberfläche spricht weiter EIN Objekt
 * (`anrufe.stumm` neben `anrufe.starten`).
 *
 * Bewusst EIGENE LiveKit-Verbindung neben der Voice-Engine: die Engine ist
 * an Guild-Kanäle gekoppelt (Presence, Bitrate, Resume, Guild-Lookups), ein
 * Anruf hätte davon nichts — der dünne Parallelweg ist weniger riskant als
 * ein dritter Modus in `livekit.svelte.ts`. Der Raum selbst liegt hinter der
 * Naht `anrufMedien.ts`: im Web (`webAnrufRaum.ts`) oder seit Etappe 4 in
 * der iOS-Hülle unter CallKit (`nativerAnrufRaum.ts`). Gewählt wird er hier,
 * einmal je Anruf.
 *
 * Aus `anruf.svelte.ts` herausgelöst (Grössen-Policy). `.svelte.ts`, weil
 * die Felder Runes sind.
 */

import { getAnrufToken } from '$lib/api/anrufe';
import { m } from '$lib/paraglide/messages.js';
import type { AnrufEndgrund } from '$lib/platform/anrufNativ';
import { toast } from 'svelte-sonner';
import type { AnrufMedien, AnrufMedienHaken, LaufenderAnruf } from './anrufMedien';
import { nativerAnrufweg, nativesGespraech } from './anrufHuelle';
import { AnrufSchluesselBund } from './anrufSchluesselweg';
import { NativerAnrufRaum } from './nativerAnrufRaum';
import { WebAnrufRaum } from './webAnrufRaum';

/** Fehler-Toast; die Meldung des Fehlers steht als Beschreibung darunter. */
export function fehlerMelden(titel: string, e: unknown): void {
  toast.error(titel, { description: e instanceof Error ? e.message : undefined });
}

export abstract class AnrufMedienZustand {
  aktiv = $state<LaufenderAnruf | null>(null);
  stumm = $state(false);
  kameranAn = $state(false);
  /** Nur nativ (iOS): Lautsprecher statt Hörmuschel. Am Ohr ist der
   *  Normalfall (Eigentümer-Entscheid, Etappe 4). */
  lautsprecher = $state(false);
  /** Läuft der Raum dieses Anrufs nativ? Zeigt den Ausgabe-Knopf. */
  nativ = $state(false);
  /** Sekunden seit Annahme — der Ticker der Overlay-UI. */
  dauerSekunden = $state(0);
  /** Overlay-Badge (E2EE-Anrufe): 'e2ee' = Ende-zu-Ende (gelesen aus
   *  `room.isE2EEEnabled`), 'transport' = Klartext-Weg, `null` = kein Anruf
   *  / noch nicht verbunden. */
  verschluesselung = $state<'e2ee' | 'transport' | null>(null);

  /** Der Medienweg des laufenden Anrufs — einmal je Anruf gewählt. */
  protected medien: AnrufMedien | null = null;
  /** Anruf-Schlüssel (E2EE-Anrufe), NUR im Arbeitsspeicher. Erzeugt und
   *  erwartet von der Signalisierung, gelesen beim Betreten des Raums. */
  protected schluessel = new AnrufSchluesselBund();
  #dauerTimer: ReturnType<typeof setInterval> | null = null;
  /** Reentrancy-Wächter für `verbinden` (Vorbild `#connectGen` in der
   *  Voice-Engine): zwei Lieferungen von `call_angenommen` oder ein
   *  Doppel-Tipp auf Annehmen durften früher zwei Räume bauen — der erste
   *  blieb als verwaiste Verbindung mit offenem Mikro zurück (Echo). */
  protected verbindenLaeuft = false;
  /** Abbau-Generation: jeder Abbau (`medienAbbauen`) und jeder
   *  Verbindungsbeginn zählt hoch — ein `verbinden`, das danach zurückkommt,
   *  erkennt daran, dass sein Anruf inzwischen abgebaut wurde. */
  #abbauGen = 0;

  /** Den Anruf lokal abbauen — die Signalisierung (`anruf.svelte.ts`). */
  protected abstract aufräumen(grund: AnrufEndgrund): void;
  /** Ein neuer Anruf steht in `aktiv` — Merker je Anruf zurücksetzen. */
  protected abstract anrufBeginnt(): void;

  /** Was der Medienweg zurückmeldet (`anrufMedien.ts`). */
  protected haken: AnrufMedienHaken = {
    verbunden: () => {
      if (this.aktiv && this.aktiv.zustand !== 'verbunden') {
        this.aktiv = { ...this.aktiv, zustand: 'verbunden' };
      }
      this.#dauerTimerStarten();
    },
    verloren: () => {
      toast.error(m.anruf_verbindung_verloren());
      this.aufräumen('fehler');
    },
    verschluesselung: (art, endgueltig) => {
      if (endgueltig || this.verschluesselung === null) this.verschluesselung = art;
    },
    stand: ({ stumm, kamera, lautsprecher }) => {
      this.stumm = stumm;
      this.kameranAn = kamera;
      this.lautsprecher = lautsprecher;
    }
  };

  get inAnruf(): boolean {
    return this.aktiv !== null;
  }

  /** Vom Empfangs-Dispatch (`empfangen.ts`, art 'anrufSchluessel'): den
   *  Schlüssel eines Anrufs merken — fail-closed, nur sauber dekodierbare
   *  32-Byte-Schlüssel (`istAnrufSchluessel`). */
  schluesselEmpfangen(anrufId: string, schluessel: string): void {
    this.schluessel.empfangen(anrufId, schluessel);
  }

  /** Den Medienweg für den beginnenden Anruf wählen — EINMAL je Anruf. */
  protected medienWaehlen(): AnrufMedien {
    this.medien?.trennen();
    const nativ = nativerAnrufweg();
    this.medien = nativ ? new NativerAnrufRaum(this.haken) : new WebAnrufRaum(this.haken);
    this.nativ = nativ;
    return this.medien;
  }

  /**
   * Nach einem Reload: läuft nativ noch ein Gespräch, übernimmt die Seite es
   * — sonst stünde das Telefonat ohne Overlay da, und auflegen ginge nur
   * noch über den System-Bildschirm. Dieselbe Klasse wie beim Kanal
   * (Bughunt E5, `voice/nativAbgleich.ts`).
   */
  async nativUebernehmen(): Promise<void> {
    if (this.aktiv) return;
    const z = await nativesGespraech();
    if (!z || this.aktiv) return;
    const k = z.kontext;
    this.aktiv = {
      id: z.kennung,
      art: k.art === 'gruppe' ? 'gruppe' : 'dm',
      channel_id: k.kanalId ?? '',
      rolle: k.rolle === 'ausgehend' ? 'ausgehend' : 'eingehend',
      gegenstelle: k.gegenstelle ?? '',
      zustand: 'klingelt'
    };
    this.anrufBeginnt();
    const medien = new NativerAnrufRaum(this.haken);
    this.medien = medien;
    this.nativ = true;
    if (z.seit !== null) {
      this.dauerSekunden = Math.max(0, Math.round((Date.now() - z.seit) / 1000));
    }
    medien.uebernehmen(z);
  }

  /** Auch schon während des Klingelns: der Stand gilt dann beim Verbinden
   *  (`#verbindenInnere` reicht `stumm` weiter). */
  async stummUmschalten(): Promise<void> {
    const medien = this.medien;
    if (!medien) return;
    const vorher = this.stumm;
    this.stumm = !vorher;
    try {
      await medien.mikrofon(vorher);
    } catch (e) {
      // Zurückrollen, sonst behauptet der Knopf etwas, das der Raum nie tat
      // (Toggle-Desync) — und die Ablehnung landet nicht als unbehandelte
      // Ablehnung im Nirgendwo.
      this.stumm = vorher;
      fehlerMelden(m.anruf_aktion_fehlgeschlagen(), e);
    }
  }

  async kameraUmschalten(): Promise<void> {
    const medien = this.medien;
    if (!medien || this.aktiv?.zustand !== 'verbunden') return;
    const vorher = this.kameranAn;
    this.kameranAn = !vorher;
    try {
      await medien.kamera(this.kameranAn);
    } catch (e) {
      this.kameranAn = vorher;
      fehlerMelden(m.anruf_aktion_fehlgeschlagen(), e);
    }
  }

  /** Lautsprecher ↔ Hörmuschel — nur auf dem nativen Weg (iOS). */
  async ausgabeUmschalten(): Promise<void> {
    const medien = this.medien;
    if (!medien?.nativ) return;
    const vorher = this.lautsprecher;
    this.lautsprecher = !vorher;
    try {
      await medien.ausgabe(this.lautsprecher);
    } catch (e) {
      this.lautsprecher = vorher;
      fehlerMelden(m.anruf_aktion_fehlgeschlagen(), e);
    }
  }

  /** LiveKit-Raum betreten — Token von voice-signaling, Room-Name vom Server;
   *  den Raum baut der Medienweg (`anrufMedien.ts`). */
  protected async verbinden(): Promise<void> {
    const anruf = this.aktiv;
    if (!anruf || this.verbindenLaeuft) return;
    this.verbindenLaeuft = true;
    try {
      await this.#verbindenInnere(anruf);
    } finally {
      this.verbindenLaeuft = false;
    }
  }

  async #verbindenInnere(anruf: LaufenderAnruf): Promise<void> {
    const schluessel = this.schluessel.holen(anruf.id);
    const gen = ++this.#abbauGen;
    const medien = this.medien ?? this.medienWaehlen();
    try {
      const zugang = await getAnrufToken(anruf.id);
      if (gen !== this.#abbauGen) return; // inzwischen abgebaut
      await medien.verbinden(anruf, zugang, schluessel, this.stumm, () => gen === this.#abbauGen);
    } catch (e) {
      if (gen !== this.#abbauGen) return;
      fehlerMelden(m.anruf_verbindung_fehlgeschlagen(), e);
      this.aufräumen('fehler');
    }
  }

  #dauerTimerStarten(): void {
    // Reconnect (Connected feuert erneut) startet keinen zweiten Ticker —
    // früher liefen dann zwei Intervalle parallel (Leak, Befund 03.10.), und
    // die Dauer sprang zurück auf null.
    if (this.#dauerTimer) return;
    this.#dauerTimer = setInterval(() => {
      this.dauerSekunden += 1;
    }, 1000);
  }

  /** Die Medienseite abbauen — Ticker, Knöpfe, zuletzt der Raum. Der Anruf
   *  ist danach weg (`aktiv = null`), BEVOR der Raum getrennt wird. */
  protected medienAbbauen(): void {
    this.#abbauGen++;
    if (this.#dauerTimer) {
      clearInterval(this.#dauerTimer);
      this.#dauerTimer = null;
    }
    const medien = this.medien;
    this.medien = null;
    this.nativ = false;
    this.stumm = false;
    this.kameranAn = false;
    this.lautsprecher = false;
    this.dauerSekunden = 0;
    this.verschluesselung = null;
    this.aktiv = null;
    medien?.trennen();
  }
}
