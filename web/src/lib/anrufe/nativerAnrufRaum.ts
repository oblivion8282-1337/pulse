/**
 * Der Medienweg über den nativen Raum der iOS-Hülle (Etappe 4, Entwurf
 * `docs/superpowers/specs/2026-10-10-ios-nativer-sprachweg-design.md` §2:
 * „Nativ — Sprachkanäle UND Direktanrufe").
 *
 * **Was die Hülle hier übernimmt:** den LiveKit-Raum, CallKit für JEDES
 * Gespräch (auch das in der App angenommene oder begonnene), die
 * Audio-Session samt Hörmuschel, und die Pause des Sprachkanals — ein Anruf
 * gewinnt (`AnrufSitzung.swift`, `SpracheRaumStumm.swift`). **Was im Web
 * bleibt:** Signalisierung, Token und Schlüssel — wie beim Kanal.
 *
 * **Der Abbau läuft über `beenden`, nicht hier.** `aufräumen` im Zustand
 * ruft `anrufNativ.beenden(grund)` für jeden Weg (Android: Notification weg,
 * iOS: CallKit-Anruf zu) — die Hülle trennt dabei den Raum mit. `trennen`
 * gibt deshalb nur frei, was das Web hält.
 *
 * Schlichtes `.ts`, ohne Runes (CLAUDE.md: eine Rune ausserhalb von
 * `.svelte(.ts)` reisst zur Laufzeit die Route ab).
 */

import { anrufNativ, type AnrufRaumZustand } from '$lib/platform/anrufNativ';
import { mitFrist, SPRACHE_FRIST_KETTE_MS, SPRACHE_FRIST_SOFORT_MS } from '$lib/platform/brueckenFrist';
import { nativerTonHalten } from '$lib/platform/iosSprache';
import type { AnrufMedien, AnrufMedienHaken, LaufenderAnruf } from './anrufMedien';

export class NativerAnrufRaum implements AnrufMedien {
  readonly nativ = true;
  #haken: AnrufMedienHaken;
  #abmelden: (() => void) | null = null;
  #haelt = false;
  /** Der Anruf, dessen Raum hier gespiegelt wird — ein Ereignis eines
   *  anderen (eines eben beendeten) bleibt draussen. */
  #kennung: string | null = null;

  constructor(haken: AnrufMedienHaken) {
    this.#haken = haken;
  }

  /**
   * **Vor dem ersten Ruf an die Hülle:** WebKits Session auf `ambient` und
   * `iosTon` aus dem Spiel (`nativerTonHalten`). Ein Ton der Oberfläche nähme
   * sonst CallKits Session die Routen-Hoheit — dieselbe Falle wie beim
   * Beitritts-Ton des Kanals (Messung an `webSessionTyp`).
   */
  #halten(kennung: string): void {
    this.#kennung = kennung;
    if (!this.#haelt) {
      this.#haelt = true;
      nativerTonHalten('anruf', true);
    }
    if (!this.#abmelden) {
      const griff = anrufNativ.addListener('anrufRaum', (z) => this.#spiegeln(z));
      this.#abmelden = () => void griff.then((g) => g.remove()).catch(() => undefined);
    }
  }

  async vorbereitenAusgehend(anruf: LaufenderAnruf): Promise<void> {
    this.#halten(anruf.id);
    await mitFrist(
      anrufNativ.ausgehend({ callId: anruf.id, gegenstelle: anruf.gegenstelle }),
      SPRACHE_FRIST_SOFORT_MS,
      'ausgehend'
    ).catch((e: unknown) => console.warn('[anruf] CallKit-Anruf beginnen fehlgeschlagen', e));
  }

  async vorbereitenAnnahme(anruf: LaufenderAnruf): Promise<void> {
    this.#halten(anruf.id);
    await mitFrist(
      anrufNativ.annehmen({ callId: anruf.id, gegenstelle: anruf.gegenstelle }),
      SPRACHE_FRIST_SOFORT_MS,
      'annehmen'
    ).catch((e: unknown) => console.warn('[anruf] Annahme bei CallKit fehlgeschlagen', e));
  }

  /**
   * Kein `mitFrist` um den Beitritt — dieselbe Begründung wie beim Kanal
   * (`brueckenFrist.ts`): der Mikrofon-Dialog wartet auf den Nutzer, und ein
   * hängender Aufbau hat schon einen Ausweg — Auflegen läuft an der Kette
   * der Hülle vorbei (`beenden` → `AnrufRaum.verlassen`) und bricht ihn ab.
   */
  async verbinden(
    anruf: LaufenderAnruf,
    zugang: { ws_url: string; token: string },
    schluessel: string | null,
    stumm: boolean,
    aktuell: () => boolean
  ): Promise<void> {
    this.#halten(anruf.id);
    const z = await anrufNativ.raumBeitreten({
      callId: anruf.id,
      wsUrl: zugang.ws_url,
      token: zugang.token,
      ...(schluessel === null ? {} : { schluessel }),
      stumm,
      art: anruf.art,
      kanalId: anruf.channel_id,
      rolle: anruf.rolle,
      gegenstelle: anruf.gegenstelle
    });
    if (aktuell()) this.#spiegeln(z);
  }

  /** Eine neu geladene Seite übernimmt ein Gespräch, das nativ weiterlief. */
  uebernehmen(z: AnrufRaumZustand): void {
    this.#halten(z.kennung);
    this.#spiegeln(z);
  }

  async mikrofon(an: boolean): Promise<void> {
    this.#spiegeln(
      await mitFrist(anrufNativ.raumMikrofon({ an }), SPRACHE_FRIST_KETTE_MS, 'raumMikrofon')
    );
  }

  async kamera(an: boolean): Promise<void> {
    this.#spiegeln(
      await mitFrist(anrufNativ.raumKamera({ an }), SPRACHE_FRIST_KETTE_MS, 'raumKamera')
    );
  }

  async ausgabe(lautsprecher: boolean): Promise<void> {
    this.#spiegeln(
      await mitFrist(
        anrufNativ.raumAusgabe({ lautsprecher }),
        SPRACHE_FRIST_SOFORT_MS,
        'raumAusgabe'
      )
    );
  }

  trennen(): void {
    this.#abmelden?.();
    this.#abmelden = null;
    this.#kennung = null;
    if (this.#haelt) {
      this.#haelt = false;
      nativerTonHalten('anruf', false);
    }
  }

  /**
   * **Der Stand der Hülle ist die Wahrheit** — Mikrofon, Kamera und Ausgabe
   * ändern sich dort auch ohne die Oberfläche (Stummschalter und
   * Lautsprecher-Taste im CallKit-Bildschirm). Ein Raum, den die Hülle
   * verloren hat, meldet sich hier NICHT als Abbruch: das tut die aufbewahrte
   * Aktion `getrennt`, die auch eine eingefrorene Oberfläche nach dem
   * Aufwachen noch erreicht.
   */
  #spiegeln(z: AnrufRaumZustand): void {
    if (!z.kennung || z.kennung !== this.#kennung) return;
    if (z.zustand === 'connected') this.#haken.verbunden();
    this.#haken.verschluesselung(z.verschluesselt ? 'e2ee' : 'transport', true);
    this.#haken.stand({ stumm: !z.mikro, kamera: z.kamera, lautsprecher: z.lautsprecher });
  }
}
