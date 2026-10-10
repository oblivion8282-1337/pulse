import { audioSessionTyp, type AudioSessionTyp, type TonModus } from './tonModus';

/*
 * WebKits Audio-Session über die W3C-Schnittstelle (`navigator.audioSession`)
 * — der Teil von `iosTon.ts`, der nicht unsere eigene Session schaltet,
 * sondern WebKit eine Absicht nennt. Eigene Datei wegen der Grössen-Policy
 * (`PLAN.md` §12.1); reine Verschiebung, Verhalten unverändert. Die zweite
 * Schreibstelle derselben Eigenschaft steht in `iosSprache.ts`
 * (`webSessionTyp`).
 */

/**
 * **AUS — am 2026-10-10 am Geraet gemessen, mit Vorher/Nachher.**
 *
 * Die Vermutung war, diese Schnittstelle sei der Hebel auf WebKits eigene
 * Session: die Session, die den Sprachton wirklich abspielt, gehoert WebKits
 * Prozess, und unser natives `overrideOutputAudioPort` erreicht sie nicht —
 * es dreht unsere Session (die meldet danach brav `Receiver`), waehrend die
 * aktive Systemroute auf dem Lautsprecher bleibt. Daran scheitert die
 * Hoermuschel, und deshalb beweist der funktionierende Lautsprecher nichts:
 * dorthin geht WebKit von selbst.
 *
 * **Gemessen, mit und ohne diese Zeile, je drei Beitritte, iOS 26.6.2:**
 *
 * | | WebKits Session im Geraetelog |
 * |---|---|
 * | aus | `PlayAndRecord_WithBluetooth_DefaultToSpeaker/VideoChat` |
 * | an | dasselbe, plus einmal `…_DefaultToSpeaker/Default` |
 *
 * Die Zeile KOMMT also an — der Modus kippte sichtbar. **`DefaultToSpeaker`
 * bleibt trotzdem**, und genau darauf kam es an. Das deckt sich mit der
 * W3C-API: sie kennt die Typen `auto`/`playback`/`ambient`/`play-and-record`
 * und kein Gegenstueck zu `defaultToSpeaker` — eine Route waehlt man damit
 * nicht.
 *
 * Geblieben ist nur eine Nebenwirkung, und zwar eine unerwuenschte: in
 * `Default` statt `VideoChat` ist Apples Sprachverarbeitung AUS, waehrend
 * unsere Seite sie fuer an haelt (`tonSystemFiltert` liest unsere eigene
 * Session) — ein Fenster ohne jede Echo-Unterdrueckung. Beobachtet wurde es
 * beim Wechsel zwischen zwei Beitritten, nicht im laufenden Gespraech; ein
 * Risiko ohne Gegenwert bleibt es trotzdem.
 *
 * **Die Abbildung bleibt stehen** (samt Tests) und der Schalter auch, denn
 * eine Frage ist ungeprueft: ob diese Absichtserklaerung mitentscheidet, ob
 * WebKit die Seite bei gesperrtem Bildschirm weiterlaufen laesst. Wer das
 * messen will, hat hier den Schalter — und oben die Zahlen, gegen die er
 * vergleichen muss.
 *
 * **Was die Hoermuschel wirklich braucht:** dass der Sprachton nicht mehr von
 * WebKit abgespielt wird. Dafuer gibt es keine Abkuerzung aus dem Web heraus.
 *
 * **Zweite Schreibstelle derselben Eigenschaft, und sie ist seit dem
 * 2026-10-10 die wichtige:** `webSessionTyp` in `platform/iosSprache.ts`
 * erklärt WebKits Session für die Dauer des nativen Sprachraums als
 * `ambient`. Dort steht die Messung, warum — ohne das übernimmt der erste
 * Oberflächen-Ton nach dem Beitritt die Routen-Hoheit und unterbricht die
 * Session der Hülle, womit die Hörmuschel unerreichbar wird.
 *
 * Heute kollidieren die beiden nicht: dieser Schalter ist aus, und solange
 * der native Raum steht, schweigt `webAudioSession` ohnehin (`schritt` in
 * `iosTon.ts`).
 */
const WEB_AUDIO_SESSION_AN = false;

/** Zuletzt an WebKit gemeldeter Typ — eigener Merker, weil der Web-Teil
 *  auch dort gilt, wo der native gar nicht laeuft (Safari am iPhone). */
let webTyp: AudioSessionTyp | null = null;

/**
 * WebKit die Absicht nennen (W3C Audio Session API).
 *
 * **Absichtlich VOR dem Capacitor-Gate und ohne es.** Die Schnittstelle ist
 * Web-Standard, kein Huellen-Zusatz: sie wirkt in Safari am iPhone genauso
 * wie in unserer App, und beide haben dasselbe Problem — WebKit waehlt die
 * AVAudioSession nach dem, was es auf der Seite sieht, und weiss ohne diese
 * Zeile nichts von unserer Absicht. Fehlt die Schnittstelle (Chromium, Safari
 * vor iOS 17), geschieht nichts; das ist der richtige Rueckfall, denn dort
 * gibt es auch keine Session zu beeinflussen.
 *
 * Der Merker ist von `angewandt` in `iosTon.ts` getrennt: dieses wird
 * absichtlich zurueckgesetzt (nach dem nativen Raum, `NACH_NATIVEM_RAUM`),
 * damit die NATIVE Einrichtung erneut laeuft — die Absichtserklaerung an
 * WebKit muss deswegen aber nicht neu geschrieben werden.
 */
export function webAudioSession(ziel: TonModus): void {
  if (!WEB_AUDIO_SESSION_AN) return;
  const typ = audioSessionTyp(ziel);
  if (typ === webTyp) return;
  if (typeof navigator === 'undefined') return;
  const nav = navigator as Navigator & { audioSession?: { type: string } };
  if (!nav.audioSession) return;
  try {
    nav.audioSession.type = typ;
    webTyp = typ;
  } catch {
    // Ein nicht angenommener Wert darf nichts weiter nach sich ziehen; den
    // Merker NICHT setzen, damit der naechste Anlauf es erneut versucht.
  }
}

/** Testhilfe / Abmeldung: der nächste Aufruf schreibt wieder. */
export function webAudioSessionVergessen(): void {
  webTyp = null;
}
