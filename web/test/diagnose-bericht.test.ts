/**
 * Tests fuer den Zuschauer-Diagnosesammler (`src/lib/stream/diagnose-bericht.ts`).
 *
 * **Warum es diese Datei ueberhaupt gibt, obwohl im Web sonst nicht unit-
 * getestet wird:** Verdichtung und Deckel sind reine Rechenlogik, deren
 * Fehler NICHT auffallen. Ein zu frueh greifender Deckel verwirft Ereignisse
 * still, eine kaputte Verdichtung blaeht den Bericht auf — beides sieht man
 * erst Wochen spaeter an Daten, die man dann nicht mehr einordnen kann. Genau
 * diese Sorte Logik hat schon einmal drei echte Fehler getragen, die erst der
 * erste Testlauf zutage foerderte.
 *
 * Ausgefuehrt mit Nodes eingebautem Testlaeufer, ohne jede zusaetzliche
 * Abhaengigkeit: `pnpm test:unit`. Node streift die Typen selbst ab, und das
 * Modul hat ausschliesslich `import type`, also keinen Laufzeit-Import, der
 * eine Browser-Umgebung braeuchte.
 *
 * **Das ist eine Bedingung, keine Beobachtung.** Ein einziger echter Import
 * aus dem Nachbarmodul genuegt, und dieser Test laeuft nicht mehr: die
 * Web-Quellen importieren erweiterungslos (`from './whep-stats'`), was der
 * Bundler aufloest und Node nicht. Wer hier also eine gemeinsame Hilfsfunktion
 * einziehen will, um eine Doppelung zu tilgen, bezahlt sie mit der
 * Testbarkeit — nachgemessen am 2026-08-06.
 */

import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import { DiagnoseSammler } from '../src/lib/stream/diagnose-bericht.ts';
import type { DiagnosticSnapshot, StreamStats } from '../src/lib/stream/whep-stats.ts';

// Die Uhr wird gestellt, nicht abgewartet. Ohne das waere das Zeitfenster der
// Verdichtung nur mit echten Wartezeiten pruefbar — und ein Test, der zehn
// Sekunden schlaeft, wird abgeschaltet, sobald er stoert.
let uhr = 0;
beforeEach(() => {
  uhr = 0;
  globalThis.performance = { now: () => uhr } as Performance;
});

const KONTEXT = { kanal: '123', sender: '456', slot: 0 };

/** Ein Messpunkt. Alle Zaehler auf 0, ueberschrieben wird nur das Noetige. */
function snapshot(ueber: Partial<DiagnosticSnapshot> = {}): StreamStats {
  const d: DiagnosticSnapshot = {
    framesReceived: 100,
    framesDecoded: 100,
    keyFramesDecoded: 1,
    framesDropped: 0,
    pliCount: 0,
    firCount: 0,
    nackCount: 0,
    packetsLost: 0,
    packetsReceived: 1000,
    jitter: 0.01,
    decoderImplementation: 'ExternalDecoder',
    frameWidth: 1920,
    frameHeight: 1080,
    framesPerSecond: 60,
    bytesReceived: 1_000_000,
    frozen: false,
    freezeSeconds: 0,
    freezeCount: 0,
    totalFreezesDuration: 0,
    pauseCount: 0,
    interFrameDelayMs: 16.7,
    interFrameJitterMs: 1.2,
    ...ueber,
  };
  return {
    res: '1920x1080',
    fps: '60 fps',
    bitrate: '4000 kbit/s',
    codec: 'AV1',
    frozen: d.frozen,
    freezeSeconds: d.freezeSeconds,
    microStutters: d.freezeCount,
    diagnostic: d,
  };
}

describe('Verdichtung', () => {
  it('fasst gleichartige Ereignisse im Fenster zu einem Eintrag zusammen', () => {
    const s = new DiagnoseSammler(KONTEXT);
    for (let i = 0; i < 50; i++) {
      uhr += 100;
      s.ereignis('stottern');
    }
    const b = s.bericht('beendet');
    assert.equal(b.ereignisse.length, 1, '50 Vorfaelle in 5 s sind EIN Eintrag');
    assert.equal(b.ereignisse[0].anzahl, 50, 'die Anzahl darf dabei nicht verlorengehen');
  });

  it('beginnt nach dem Fenster einen neuen Eintrag', () => {
    const s = new DiagnoseSammler(KONTEXT);
    s.ereignis('stottern');
    uhr += 11_000;
    s.ereignis('stottern');
    const b = s.bericht('beendet');
    assert.equal(b.ereignisse.length, 2, 'ueber das Fenster hinaus wird nicht verschmolzen');
  });

  it('verschmilzt verschiedene Arten nicht miteinander', () => {
    const s = new DiagnoseSammler(KONTEXT);
    s.ereignis('stottern');
    s.ereignis('einfrieren');
    assert.equal(s.bericht('beendet').ereignisse.length, 2);
  });

  it('haelt den Zeitpunkt ehrlich, wenn ein Ereignis regelmaessig wiederkehrt', () => {
    // Die Falle: verschmilzt man mit IRGENDEINEM Eintrag im Fenster statt mit
    // dem juengsten, faellt ein alle 9 s wiederkehrendes Ereignis ueber eine
    // ganze Stunde auf Sekunde 0 zusammen — der Zeitpunkt waere gelogen.
    const s = new DiagnoseSammler(KONTEXT);
    for (let i = 0; i < 10; i++) {
      s.ereignis('stottern');
      uhr += 9_000;
    }
    const b = s.bericht('beendet');
    assert.ok(b.ereignisse.length > 1, 'es darf nicht alles auf einen Eintrag fallen');
    const letzter = b.ereignisse[b.ereignisse.length - 1];
    assert.ok(letzter.s > 60, `der letzte Eintrag muss spaet liegen, war ${letzter.s}`);
  });
});

describe('Deckel', () => {
  it('zaehlt jenseits des Deckels nur noch und weist es AUS', () => {
    const s = new DiagnoseSammler(KONTEXT);
    // Jedes Ereignis eine eigene Art und ausserhalb des Fensters, damit nichts
    // verschmilzt und der Deckel wirklich erreicht wird.
    for (let i = 0; i < 260; i++) {
      uhr += 11_000;
      s.ereignis(`art_${i}`);
    }
    const b = s.bericht('beendet');
    assert.equal(b.ereignisse.length, 200, 'der Deckel muss greifen');
    assert.equal(b.ereignisse_verworfen, 60, 'die Kappung muss im Bericht stehen');
  });

  it('meldet keine Kappung, wenn nichts gekappt wurde', () => {
    // Gegenprobe. Ohne sie wuerde ein Zaehler, der immer etwas meldet, als
    // bestanden durchgehen — und jede saubere Sitzung saehe gekappt aus.
    const s = new DiagnoseSammler(KONTEXT);
    s.ereignis('stottern');
    assert.equal(s.bericht('beendet').ereignisse_verworfen, 0);
  });

  it('bleibt unter dem Server-Deckel', () => {
    // Der Server lehnt ab 250 Ereignissen mit 422 ab — und ein 422 verwirft
    // den GANZEN Bericht, nicht nur das ueberzaehlige Ereignis.
    const s = new DiagnoseSammler(KONTEXT);
    for (let i = 0; i < 500; i++) {
      uhr += 11_000;
      s.ereignis(`art_${i}`);
    }
    assert.ok(s.bericht('beendet').ereignisse.length < 250);
  });
});

describe('Ereignisse aus den Messpunkten', () => {
  it('leitet Ereignisse aus DELTAS ab, nicht aus den Staenden', () => {
    // Der erste Messpunkt hat keinen Vorgaenger und darf deshalb nichts
    // ausloesen — sonst meldete jede Sitzung beim Einstieg alles, was der
    // kumulative Zaehler seit dem Verbindungsaufbau angesammelt hat.
    const s = new DiagnoseSammler(KONTEXT);
    s.beobachte(snapshot({ freezeCount: 40, framesDropped: 12, pliCount: 3 }));
    assert.equal(s.bericht('beendet').ereignisse.length, 0);

    uhr += 1000;
    s.beobachte(snapshot({ freezeCount: 43, framesDropped: 12, pliCount: 3 }));
    const b = s.bericht('beendet');
    assert.equal(b.ereignisse.length, 1);
    assert.equal(b.ereignisse[0].art, 'stottern');
    assert.equal(b.ereignisse[0].anzahl, 3, 'die Differenz, nicht der Stand');
  });

  it('haelt den Decoder-Wechsel fest', () => {
    // Das wertvollste Einzelereignis: Chromiums Hardware-Decoder steigt mitten
    // im Lauf aus und libwebrtc faellt auf dav1d zurueck. Ohne diese Zeile
    // sieht man spaeter nur "ab hier war das Bild kaputt", nicht warum.
    const s = new DiagnoseSammler(KONTEXT);
    s.beobachte(snapshot({ decoderImplementation: 'ExternalDecoder' }));
    uhr += 1000;
    s.beobachte(snapshot({ decoderImplementation: 'libdav1d' }));
    const e = s.bericht('beendet').ereignisse.find((x) => x.art === 'decoder_gewechselt');
    assert.ok(e, 'der Wechsel muss auftauchen');
    assert.equal(e.werte?.nach, 'libdav1d');
  });

  it('meldet eine andauernde Einfrierung einmal, nicht je Messpunkt', () => {
    const s = new DiagnoseSammler(KONTEXT);
    s.beobachte(snapshot());
    for (let i = 1; i <= 30; i++) {
      uhr += 1000;
      s.beobachte(snapshot({ frozen: true, freezeSeconds: i }));
    }
    const einfrierungen = s.bericht('beendet').ereignisse.filter((x) => x.art === 'einfrieren');
    assert.equal(einfrierungen.length, 1, '30 s Einfrieren sind EIN Vorfall');
    assert.equal(einfrierungen[0].anzahl, 1);
    assert.equal(einfrierungen[0].werte?.dauer_s, 30, 'die Dauer muss nachgezogen werden');
  });

  it('zaehlt Verlust in Paketen, nicht in NACK-Anforderungen', () => {
    // Die NACK-Zahl ist um den Faktor ~9 aufgeblaeht, weil Chromium dieselbe
    // Luecke mehrfach anfordert. Sie beschreibt den Empfaenger, nicht die
    // Leitung, und darf deshalb kein Verlust-Ereignis erzeugen.
    const s = new DiagnoseSammler(KONTEXT);
    s.beobachte(snapshot({ nackCount: 100, packetsLost: 5 }));
    uhr += 1000;
    s.beobachte(snapshot({ nackCount: 900, packetsLost: 12 }));
    const b = s.bericht('beendet');
    const verlust = b.ereignisse.find((x) => x.art === 'pakete_verloren');
    assert.equal(verlust?.anzahl, 7, 'die Paket-Differenz, nicht die NACK-Differenz');
    assert.equal(b.bilanz.nack_anforderungen, 900, 'in der Bilanz steht sie — klar benannt');
  });
});

describe('Bilanz', () => {
  it('fuehrt zum Verlust seine Bezugsgroesse mit', () => {
    // Eine Zaehlung ohne Bezugsgroesse ist keine Messung: 300 verlorene Pakete
    // sind bei 3000 empfangenen eine Katastrophe und bei 3 Millionen nichts.
    const s = new DiagnoseSammler(KONTEXT);
    s.beobachte(snapshot({ packetsLost: 300, packetsReceived: 2700 }));
    const bilanz = s.bericht('beendet').bilanz;
    assert.equal(bilanz.pakete_verloren, 300);
    assert.equal(bilanz.pakete_empfangen, 2700);
    assert.equal(bilanz.verlust_anteil, 0.1, 'der Anteil ist die eigentliche Aussage');
  });

  it('gibt den Verlustanteil als unbekannt aus, wenn nichts ankam', () => {
    // Nicht 0 — 0 Prozent Verlust bei 0 Paketen waere die Aussage "Leitung
    // sauber", und das Gegenteil ist der Fall.
    const s = new DiagnoseSammler(KONTEXT);
    s.beobachte(snapshot({ packetsLost: 0, packetsReceived: 0 }));
    assert.equal(s.bericht('beendet').bilanz.verlust_anteil, null);
  });

  it('haelt den Abschlussgrund fest', () => {
    const s = new DiagnoseSammler(KONTEXT);
    assert.equal(s.bericht('wiederaufbau').abschluss.grund, 'wiederaufbau');
  });
});

describe('Was ueberhaupt gesendet wird', () => {
  it('schweigt bei einer sauberen Sitzung', () => {
    const s = new DiagnoseSammler(KONTEXT);
    s.beobachte(snapshot());
    uhr += 1000;
    s.beobachte(snapshot());
    assert.equal(s.lohntSich(), false, 'eine stille Sitzung muellt den Server nicht zu');
  });

  it('meldet aber IMMER, wenn nie ein Bild dekodiert wurde', () => {
    // Der schlimmste Fall ueberhaupt — und er erzeugt womoeglich kein einziges
    // Ereignis, weil nichts passiert, wovon sich ein Delta bilden liesse.
    // "Keine Ereignisse" allein als Kriterium wuerde genau ihn verschlucken.
    const s = new DiagnoseSammler(KONTEXT);
    s.beobachte(snapshot({ framesDecoded: 0, framesReceived: 0 }));
    assert.equal(s.lohntSich(), true);
    assert.equal(s.bericht('beendet').bilanz.je_dekodiert, false);
  });

  it('meldet, sobald etwas vorgefallen ist', () => {
    const s = new DiagnoseSammler(KONTEXT);
    s.beobachte(snapshot());
    uhr += 1000;
    s.beobachte(snapshot({ freezeCount: 5 }));
    assert.equal(s.lohntSich(), true);
  });
});
