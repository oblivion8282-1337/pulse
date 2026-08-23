/**
 * Der **Rückfall des Zeigers**: der Host legt seinen Zeiger zurück ins
 * Videobild, und der Steuernde blendet dafür seinen lokalen aus.
 *
 * **Warum es diesen Test gibt.** Die Funktion hat genau einen katastrophalen
 * Ausgang, und der ist nicht „sie wirkt nicht", sondern: der lokale Zeiger
 * bleibt nach dem Ende der Fernsteuerung ausgeblendet. Der Nutzer sitzt dann
 * ohne Zeiger vor seinem eigenen Rechner und hat kein Mittel mehr, das zu
 * beheben — es gibt keinen Knopf, den er noch träfe. Deshalb prüft dieser Test
 * zuerst das Zurücksetzen und erst danach die Wirkung.
 *
 * Die zweite Gefahr ist die Deutung der Nutzlast. Sie kommt vom Rechner des
 * Gegenübers: eine ältere Gegenseite, ein selbstgebauter Client, eine
 * abgeschnittene Nachricht. **Der sichere Fall ist „Zeiger sichtbar"** — ein
 * doppelter Zeiger ist ein Schönheitsfehler, ein fehlender kostet die
 * Bedienbarkeit. Ein `{"aktiv": "ja"}` darf deshalb NICHT ausblenden.
 *
 * Geprüft wird [`ZeigerImBild`] und nicht `zeigerform.ts` selbst: dessen
 * Laufzeit-Import (`./sidecarInput`) ist erweiterungslos und für Nodes
 * Testläufer unerreichbar. Genau deshalb liegt die Entscheidung nebenan —
 * gleiches Muster wie `zeigerbildPruefung.ts` und `vorrangTakt.ts`. Der letzte
 * Block prüft am Quelltext nach, dass `zeigerform.ts` sie wirklich benutzt: die
 * Rückstellung nützt nichts, wenn sie niemand ruft.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { ZeigerImBild, deuteZeigerImBild, sidecarMeldungImBild } from '../src/lib/remote/zeigerImBild.ts';

describe('deuteZeigerImBild — die Nutzlast des Hosts', () => {
  it('blendet nur bei einem ausdrücklichen true aus', () => {
    assert.equal(deuteZeigerImBild({ aktiv: true }), true);
  });

  it('lässt den Zeiger bei allem anderen sichtbar — der sichere Fall', () => {
    // Wahrheitsähnliches ist NICHT wahr: ein selbstgebauter oder älterer
    // Sender schickt leicht einen String oder eine Zahl, und ein fehlender
    // Zeiger ist schlimmer als ein doppelter.
    for (const data of [
      { aktiv: 'ja' },
      { aktiv: 'true' },
      { aktiv: 1 },
      { aktiv: false },
      { aktiv: null },
      { aktiv: {} },
      {},
      { anderes: true },
      null,
      undefined,
      'aktiv',
      42,
      true,
      [],
    ]) {
      assert.equal(deuteZeigerImBild(data), false, `${JSON.stringify(data)} darf nicht ausblenden`);
    }
  });

  it('stürzt an keiner Nutzlast', () => {
    // Der Gateway parst den Inhalt nicht — was hier ankommt, kann alles sein.
    for (const data of [Object.create(null), new Date(), { aktiv: Symbol('x') }]) {
      assert.doesNotThrow(() => deuteZeigerImBild(data));
    }
  });
});

describe('ZeigerImBild — der Stand beim Steuernden', () => {
  it('fängt sichtbar an', () => {
    assert.equal(new ZeigerImBild().aktiv, false);
  });

  it('meldet den Wechsel und nur den Wechsel', () => {
    const z = new ZeigerImBild();
    assert.equal(z.signal({ aktiv: true }), true, 'der Beginn muss ins Fenster');
    assert.equal(z.aktiv, true);
    // Der Sender wiederholt je Sekunde, weil der Sekundendeckel des Gateways
    // still verwirft. Das darf kein IPC je Sekunde kosten.
    assert.equal(z.signal({ aktiv: true }), false, 'die Wiederholung wird geschluckt');
    assert.equal(z.signal({ aktiv: false }), true, 'das Ende muss ins Fenster');
    assert.equal(z.aktiv, false);
    assert.equal(z.signal({ aktiv: false }), false);
  });

  it('heilt ein verlorenes „aktiv" über die nächste Wiederholung', () => {
    // Der Gateway deckelt `remote_signal` je Sekunde und verwirft still. Ging
    // die erste Meldung verloren, ist der Stand hier noch `false` — die
    // Wiederholung ist dann eine Änderung und kommt durch.
    const z = new ZeigerImBild();
    assert.equal(z.signal({ aktiv: true }), true);
  });

  it('nimmt eine unbrauchbare Meldung als „sichtbar" und beendet damit den Rückfall', () => {
    const z = new ZeigerImBild();
    z.signal({ aktiv: true });
    assert.equal(z.signal({ aktiv: 'ja' }), true, 'Unbrauchbares fällt auf den sicheren Fall');
    assert.equal(z.aktiv, false);
  });

  it('gibt beim Sitzungsende den Zeiger zurück — der eine Fall, der nie fehlen darf', () => {
    const z = new ZeigerImBild();
    z.signal({ aktiv: true });
    assert.equal(z.beenden(), true, 'dem Player-Fenster ist eine Rückstellung geschuldet');
    assert.equal(z.aktiv, false, 'nach dem Sitzungsende MUSS der Zeiger sichtbar sein');
  });

  it('schuldet dem Fenster nichts, wenn gar kein Rückfall lief', () => {
    // Sonst ginge am Ende jeder gewöhnlichen Sitzung eine Meldung ins Fenster,
    // die nichts ändert.
    assert.equal(new ZeigerImBild().beenden(), false);
  });

  it('fängt nach dem Ende wieder bei sichtbar an', () => {
    const z = new ZeigerImBild();
    z.signal({ aktiv: true });
    z.beenden();
    // Die nächste Sitzung darf nicht mit einem geerbten Rückfall starten.
    assert.equal(z.beenden(), false);
    assert.equal(z.signal({ aktiv: true }), true);
  });
});

describe('Verdrahtung in zeigerform.ts', () => {
  // Der Testläufer kann `zeigerform.ts` nicht importieren (s. Kopf). Geprüft
  // wird deshalb der Quelltext — nicht auf Wortlaut, sondern auf die zwei
  // Eigenschaften, um die es geht: `stop()` nimmt den Rückfall zurück UND sagt
  // das dem Fenster. Fällt eines von beiden weg, bleibt der Nutzer ohne Zeiger
  // zurück, und kein anderer Test hier merkt es.
  const stop = methodenKoerper('stop');

  it('nimmt den Rückfall beim Sitzungsende zurück', () => {
    assert.match(
      stop,
      /this\.#imBild\.beenden\(\)/,
      'stop() muss ZeigerImBild.beenden() rufen — sonst bleibt der lokale Zeiger ausgeblendet',
    );
  });

  it('meldet die Rückstellung auch ins Player-Fenster', () => {
    // Der Player hält den Stand selbst; ohne diese Meldung erführe er nie,
    // dass der Rückfall vorbei ist.
    assert.match(
      stop,
      /this\.#senke\?\.\(VORGABE,undefined,false\)/,
      'stop() muss die Senke mit imBild=false beliefern',
    );
    // Und die Rückstellung muss auch dann hinausgehen, wenn sonst nichts zu
    // melden wäre (Form unverändert, kein Bild) — genau das ist der Fall auf
    // macOS, wo der Rückfall ohne jede Formmeldung läuft.
    assert.match(
      stop,
      /rueckfallStand/,
      'die Bedingung von stop() muss den Rückfall einschliessen',
    );
  });

  it('deutet das Signal nicht selbst, sondern über den geprüften Baustein', () => {
    const koerper = methodenKoerper('_signalImBild');
    assert.match(
      koerper,
      /this\.#imBild\.signal\(data\)/,
      '_signalImBild muss ZeigerImBild.signal(data) benutzen',
    );
    // Eine eigene Deutung daneben (`data.aktiv`, `!!data`, `==`) wäre eine
    // zweite Wahrheit, die dieser Test nicht mehr abdeckt. Geprüft wird
    // deshalb, dass `data` den Körper NUR über `signal()` verlässt.
    assert.doesNotMatch(
      koerper.replace('this.#imBild.signal(data)', ''),
      /data/,
      '_signalImBild darf die Nutzlast nicht selbst deuten',
    );
    // **Bewusst nicht die ganze Import-Liste festnageln.** Diese Prüfung hiess
    // bis zum 2026-08-23 `\{\s*ZeigerImBild\s*\}` und verlangte damit, dass
    // aus dieser Datei GENAU EIN Name importiert wird. Als die Weiterleitung
    // `sidecarMeldungImBild` dazukam — eine Änderung, die die Zusage stärkt,
    // weil sie eine weitere Deutung aus `zeigerform.ts` heraushält — fiel der
    // Test um. Ein Test, der bei einer Verbesserung rot wird, erzieht dazu,
    // ihn abzuschalten. Geprüft wird deshalb, dass `ZeigerImBild` von dort
    // kommt, nicht, dass sonst nichts von dort kommt.
    assert.match(
      quelleZeigerform(),
      /import\s*\{[^}]*\bZeigerImBild\b[^}]*\}\s*from\s*'\.\/zeigerImBild'/,
      'die Entscheidung muss aus zeigerImBild kommen — sonst prüft der Test oben etwas anderes',
    );
  });

  it('liefert den Stand an ein später angehängtes Fenster nach', () => {
    // Das Player-Fenster hängt sich nach dem Sitzungsbeginn an. Ohne die
    // Nachlieferung sähe der Steuernde in einem zweiten Fenster (zweiter
    // Bildschirm eines Standplatz-Geräts) zwei Zeiger.
    assert.match(
      methodenKoerper('setSenke'),
      /this\.#imBild\.aktiv/,
      'setSenke muss den Stand des Rückfalls mitgeben',
    );
  });
});

/** Der Quelltext von `zeigerform.ts`. */
function quelleZeigerform(): string {
  return readFileSync(
    join(import.meta.dirname, '..', 'src', 'lib', 'remote', 'zeigerform.ts'),
    'utf8',
  );
}

/** Den Körper einer Methode aus `zeigerform.ts` holen — ohne Kommentare und
 *  ohne Leerraum, damit der Test an der Form hängt und nicht an der
 *  Formatierung. Gleiches Werkzeug wie in `vorrang-takt.test.ts`. */
function methodenKoerper(name: string): string {
  const quelle = quelleZeigerform();
  // Die DEFINITION, nicht der Aufruf: am Zeilenanfang eingerückt und mit
  // Rückgabetyp.
  const treffer = new RegExp(`^\\s*${name}\\([^)]*\\):[^{]*\\{`, 'm').exec(quelle);
  assert.ok(treffer, `${name} in zeigerform.ts nicht gefunden — Test mitziehen`);
  const i = treffer.index + treffer[0].length - 1;
  let tiefe = 0;
  let ende = i;
  for (; ende < quelle.length; ende++) {
    if (quelle[ende] === '{') tiefe++;
    else if (quelle[ende] === '}' && --tiefe === 0) break;
  }
  return quelle
    .slice(i + 1, ende)
    .replace(/\/\/[^\n]*/g, '')
    .replace(/\s+/g, '');
}

describe('sidecarMeldungImBild — die Weiterleitung auf der Host-Seite', () => {
/**
 * **Die Weiterleitung auf der Host-Seite** — sie fehlte bis zum 2026-08-23
 * ganz, und zwar in einer Luecke zwischen zwei Arbeiten: der Sidecar meldete
 * `remote_pointer_in_frame`, der Player konnte es deuten, die Doku beschrieb
 * es, und niemand reichte es weiter. Verworfen wurde es wortlos.
 *
 * Ein Absturz waere aufgefallen. Ein stillschweigend wirkungsloser Rueckfall
 * nicht: der Steuernde haette einfach immer zwei Zeiger gesehen, und niemand
 * haette die Ursache in einer fehlenden Zeile gesucht.
 */
  it('die Rueckfall-Meldung des Sidecars wird erkannt', () => {
    assert.equal(sidecarMeldungImBild({ ev: 'remote_pointer_in_frame', aktiv: true }), true);
    assert.equal(sidecarMeldungImBild({ ev: 'remote_pointer_in_frame', aktiv: false }), false);
  });

  it('andere Sidecar-Meldungen gehen den Rueckfall nichts an', () => {
    // `null` heisst „nicht meine Sache" und ist NICHT dasselbe wie `false`:
    // bei `false` geht eine Meldung hinaus, bei `null` faehrt der Aufrufer mit
    // seiner gewohnten Behandlung fort. Wer beides zusammenzieht, schickt bei
    // jeder Formmeldung zusaetzlich ein „nicht im Bild".
    assert.equal(sidecarMeldungImBild({ ev: 'remote_pointer', shape: 'text' }), null);
    assert.equal(sidecarMeldungImBild({ ev: 'remote_state', state: 'live' }), null);
    assert.equal(sidecarMeldungImBild(null), null);
    assert.equal(sidecarMeldungImBild('remote_pointer_in_frame'), null);
    assert.equal(sidecarMeldungImBild(undefined), null);
  });

  it('ein unklares aktiv gilt als nicht aktiv', () => {
    // Derselbe sichere Fall wie beim Empfaenger: ein doppelter Zeiger ist ein
    // Schoenheitsfehler, ein fehlender kostet die Bedienbarkeit.
    for (const wert of ['ja', 1, {}, null, undefined]) {
      assert.equal(
        sidecarMeldungImBild({ ev: 'remote_pointer_in_frame', aktiv: wert }),
        false,
        `aktiv=${JSON.stringify(wert)}`,
      );
    }
  });
});
