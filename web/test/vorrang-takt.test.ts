/**
 * Der Host reicht den **Herzschlag** des Vorrangs durch, nicht nur die Flanke.
 *
 * **Warum es diesen Test gibt.** Der Vorrang des Hosts hat auf beiden Seiten
 * eine Uhr: der Sidecar wiederholt einen geltenden Vorrang je Sekunde
 * (`pulse-fernsteuerung/src/sitzung/vorrang.rs::WIEDERHOLUNG_TAKTE`), der
 * Steuernde gibt ihn nach `GEDULD_MS` Schweigen als beendet auf und zieht das
 * Gehaltene nach.
 * Dazwischen sass im Host ein reiner Flankenfilter (`if (aktiv === this.#aktiv)
 * return;`), der jede Wiederholung verschluckte. Die Mindestfrist des Vorrangs
 * ist aber 5 s: die Geduld lief also mitten im geltenden Vorrang ab, das
 * Nachziehen fiel in die Sperre und wurde vom Host über `host_active`
 * verworfen (samt `druck.loslassen()`), und das spaetere echte „aus" fiel beim
 * Steuernden in denselben Flankenfilter — er hielt den Vorrang längst für
 * beendet. Ergebnis: die gehaltene Taste blieb am fernen Rechner tot.
 *
 * Der Test prüft deshalb genau das Stück, an dem beide Uhren zusammenkommen:
 * dass eine unveränderte Wiederholung nach einer Sekunde hinausgeht, dass sie
 * dabei gedeckelt bleibt (`remote_signal` hat im Gateway einen Sekundendeckel,
 * und bei mehreren Streams meldet jeder Sidecar-Prozess für sich), und dass
 * der Takt deutlich unter der Geduld des Steuernden liegt — die letzte Zusage
 * hält der Test gegen den Quelltext von `vorrang.ts`, damit ein Verstellen der
 * einen Zahl ohne die andere auffällt.
 *
 * Geprüft wird [`VorrangBuch`] und nicht `vorrang.ts` selbst: dessen
 * Laufzeit-Importe (`./p2p`, `./sidecarInput`, `./wachten`) sind
 * erweiterungslos und für Nodes Testläufer unerreichbar. Genau deshalb liegt
 * die Rechnung nebenan — gleiches Muster wie `zeigerbildPruefung.ts`.
 *
 * **Was am 2026-08-19 dazukam.** Ein Prüfer setzte in `vorrang.ts` den alten
 * Flankenfilter wieder ein — und alle Tests blieben grün: geprüft war die
 * Rechnung, nicht die Stelle, an der sie benutzt wird. Das ist dieselbe Lücke,
 * die den Fehler überhaupt möglich gemacht hat. Deshalb steht die ganze
 * Entscheidung jetzt in [`hostMeldungWeiterreichen`] (unten mit einem Sender
 * durchgefahren), und der letzte Block prüft am Quelltext nach, dass
 * `vorrang.ts` sie wirklich benutzt und **keine eigene Bedingung** mehr
 * mitbringt.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  AUFFRISCH_MS,
  SIDECAR_TAKT_MS,
  VorrangBuch,
  hostMeldungWeiterreichen,
} from '../src/lib/remote/vorrangTakt.ts';

/** Was die Wache typischerweise als Restzeit meldet (5 s Mindestfrist). */
const REST_MS = 5_000;

describe('VorrangBuch — Flanken', () => {
  it('meldet den Beginn sofort', () => {
    const buch = new VorrangBuch();
    assert.deepEqual(buch.melden(0, true, REST_MS, 1_000), {
      aktiv: true,
      senden: true,
    });
    assert.equal(buch.aktiv, true);
  });

  it('meldet das Ende sofort', () => {
    const buch = new VorrangBuch();
    buch.melden(0, true, REST_MS, 1_000);
    assert.deepEqual(buch.melden(0, false, 0, 1_200), {
      aktiv: false,
      senden: true,
    });
    assert.equal(buch.aktiv, false);
  });

  it('wiederholt „kein Vorrang" nicht — dort ist beim Steuernden nichts wachzuhalten', () => {
    const buch = new VorrangBuch();
    buch.melden(0, true, REST_MS, 1_000);
    buch.melden(0, false, 0, 1_200);
    assert.deepEqual(buch.melden(0, false, 0, 9_000), {
      aktiv: false,
      senden: false,
    });
  });
});

describe('VorrangBuch — Herzschlag', () => {
  it('reicht die Wiederholung des Sidecars nach einer Sekunde durch', () => {
    const buch = new VorrangBuch();
    assert.equal(buch.melden(0, true, REST_MS, 1_000).senden, true);
    // Genau der Fall, der vorher am Flankenfilter starb.
    assert.deepEqual(buch.melden(0, true, REST_MS, 2_000), {
      aktiv: true,
      senden: true,
    });
    assert.deepEqual(buch.melden(0, true, REST_MS, 3_000), {
      aktiv: true,
      senden: true,
    });
  });

  it('hält den Steuernden über die volle Mindestfrist hinweg wach', () => {
    // Ein Vorrang von 5 s, wie ihn die Wache setzt: der Sidecar meldet je
    // Sekunde, und zwischen zwei durchgereichten Meldungen darf nie mehr Zeit
    // liegen, als die Geduld des Steuernden hergibt.
    const buch = new VorrangBuch();
    const geduld = geduldAusQuelle();
    let letzteSendung = 1_000;
    buch.melden(0, true, REST_MS, letzteSendung);
    for (let jetzt = 2_000; jetzt <= 6_000; jetzt += 1_000) {
      const { senden } = buch.melden(0, true, REST_MS, jetzt);
      if (senden) letzteSendung = jetzt;
      assert.ok(
        jetzt - letzteSendung < geduld,
        `bei ${jetzt} ms schweigt der Host seit ${jetzt - letzteSendung} ms — die Geduld ist ${geduld} ms`,
      );
    }
  });

  it('deckelt die Wiederholung — der Gateway verwirft über seinem Sekundendeckel still', () => {
    const buch = new VorrangBuch();
    buch.melden(0, true, REST_MS, 1_000);
    // Zwei Sidecar-Prozesse (zwei Streams) melden dicht hintereinander
    // dasselbe: das darf nicht zwei Meldungen ergeben.
    assert.equal(buch.melden(1, true, REST_MS, 1_050).senden, false);
    assert.equal(buch.melden(0, true, REST_MS, 1_100).senden, false);
    assert.equal(buch.melden(1, true, REST_MS, 1_150).senden, false);
  });

  it('lässt zwei verlorene Auffrischungen die Geduld NICHT erreichen', () => {
    // Gerechnet wird mit dem Takt des SENDERS (1 s), nicht mit AUFFRISCH_MS:
    // der Deckel des Hosts begrenzt nur nach oben und beschleunigt nichts.
    // Zwei verlorene Auffrischungen sind ein Schweigen von 3 x SIDECAR_TAKT_MS
    // — mit den früheren 3 s Geduld exakt der Grenzfall, und der Sidecar-Takt
    // wird unter Eingabelast eher länger (try_lock-WouldBlock in vorrang.rs).
    const geduld = geduldAusQuelle();
    assert.ok(
      SIDECAR_TAKT_MS * 3 < geduld,
      `zwei verlorene Auffrischungen schweigen ${SIDECAR_TAKT_MS * 3} ms — die Geduld ist ${geduld} ms`,
    );
    // Der Deckel darf den Takt nicht ueber den Sender hinaus strecken.
    assert.ok(
      AUFFRISCH_MS <= SIDECAR_TAKT_MS,
      'der Deckel darf nicht langsamer sein als der Sender',
    );
  });
});

describe('VorrangBuch — mehrere Plätze', () => {
  it('bleibt aktiv, solange irgendein Platz übernommen hat', () => {
    const buch = new VorrangBuch();
    buch.melden(0, true, REST_MS, 1_000);
    buch.melden(1, true, REST_MS, 1_010);
    // Platz 0 gibt frei, Platz 1 hält noch — kein Ende.
    assert.deepEqual(buch.melden(0, false, 0, 1_020), {
      aktiv: true,
      senden: false,
    });
    assert.deepEqual(buch.melden(1, false, 0, 1_030), {
      aktiv: false,
      senden: true,
    });
  });

  it('lässt einen Platz verfallen, dessen Sidecar wortlos weg ist', () => {
    const buch = new VorrangBuch();
    buch.melden(0, true, REST_MS, 1_000);
    // Platz 0 meldet nie wieder; Platz 1 kommt lange danach und gibt frei.
    const spaet = 1_000 + REST_MS + 1_001;
    assert.deepEqual(buch.melden(1, false, 0, spaet), {
      aktiv: false,
      senden: true,
    });
  });

  it('vergisst beim Leeren alles — auch den Sendetakt', () => {
    const buch = new VorrangBuch();
    buch.melden(0, true, REST_MS, 1_000);
    buch.leeren();
    assert.equal(buch.aktiv, false);
    assert.deepEqual(buch.melden(0, true, REST_MS, 1_050), {
      aktiv: true,
      senden: true,
    });
  });
});

describe('hostMeldungWeiterreichen — die Entscheidung selbst', () => {
  /** Ein Sidecar-Ereignis, wie es über die Brücke hereinkommt. */
  function ereignis(state: 'host_active' | 'live', slot = 0, holdMs = REST_MS) {
    return { ev: 'remote_state', state, hold_ms: holdMs, slot };
  }

  /** Fährt Meldungen durch und schreibt mit, was hinausging. */
  function lauf(): {
    melden: (ev: unknown, jetzt: number) => boolean | null;
    hinaus: { aktiv: boolean; rest_ms: number }[];
  } {
    const buch = new VorrangBuch();
    const hinaus: { aktiv: boolean; rest_ms: number }[] = [];
    return {
      melden: (ev, jetzt) =>
        hostMeldungWeiterreichen(buch, ev, jetzt, (signal) => {
          hinaus.push(signal);
          return true;
        }),
      hinaus,
    };
  }

  it('reicht den Beginn hinaus und meldet den maschinenweiten Zustand', () => {
    const { melden, hinaus } = lauf();
    assert.equal(melden(ereignis('host_active'), 1_000), true);
    assert.deepEqual(hinaus, [{ aktiv: true, rest_ms: REST_MS }]);
  });

  it('reicht die unveränderte Wiederholung hinaus — das ist der Herzschlag', () => {
    const { melden, hinaus } = lauf();
    melden(ereignis('host_active'), 1_000);
    // Genau die Meldung, die der alte Flankenfilter verschluckt hat.
    assert.equal(melden(ereignis('host_active'), 2_000), true);
    assert.equal(hinaus.length, 2);
  });

  it('deckelt die Wiederholung über mehrere Plätze', () => {
    const { melden, hinaus } = lauf();
    melden(ereignis('host_active', 0), 1_000);
    melden(ereignis('host_active', 1), 1_050);
    assert.equal(hinaus.length, 1);
  });

  it('reicht das Ende sofort hinaus', () => {
    const { melden, hinaus } = lauf();
    melden(ereignis('host_active'), 1_000);
    assert.equal(melden(ereignis('live', 0, 0), 1_200), false);
    assert.deepEqual(hinaus.at(-1), { aktiv: false, rest_ms: 0 });
  });

  it('lässt fremde Ereignisse in Ruhe (null = geht uns nichts an)', () => {
    const { melden, hinaus } = lauf();
    assert.equal(melden({ ev: 'input_error' }, 1_000), null);
    assert.equal(melden(null, 1_000), null);
    assert.deepEqual(hinaus, []);
  });

  it('zählt eine Meldung ohne Platz als Platz 0', () => {
    const { melden } = lauf();
    assert.equal(
      melden({ ev: 'remote_state', state: 'host_active', hold_ms: REST_MS }, 1_000),
      true,
    );
  });

  it('klemmt eine unsinnige Restzeit ab', () => {
    const { melden, hinaus } = lauf();
    melden(ereignis('host_active', 0, Number.POSITIVE_INFINITY), 1_000);
    assert.equal(hinaus[0].rest_ms, 0);
    const zweit = lauf();
    zweit.melden(ereignis('host_active', 0, 10 ** 9), 1_000);
    assert.equal(zweit.hinaus[0].rest_ms, 60_000);
  });

  it('meldet den Zustand auch dann, wenn das Senden fehlschlägt', () => {
    const buch = new VorrangBuch();
    const aktiv = hostMeldungWeiterreichen(buch, ereignis('host_active'), 1_000, () => false);
    assert.equal(aktiv, true);
  });
});

describe('Verdrahtung in vorrang.ts', () => {
  // Der Testläufer kann `vorrang.ts` nicht importieren (s. Kopf). Geprüft wird
  // deshalb der Quelltext — aber nicht auf Wortlaut, sondern auf die eine
  // Eigenschaft, um die es geht: in `#vomSidecar` darf ausser der Rolle KEINE
  // Bedingung mehr stehen. Ein wieder eingesetzter Flankenfilter
  // (`if (aktiv === this.#aktiv) return;`) oder ein zurückgeholtes
  // `if (!senden) return;` bringt zwangsläufig einen zweiten Ausstieg mit —
  // und macht diesen Test rot.
  const koerper = methodenKoerper('#vomSidecar');

  it('benutzt die geprüfte Entscheidung, statt selbst zu entscheiden', () => {
    assert.match(
      koerper,
      /hostMeldungWeiterreichen\(this\.#buch,ev,Date\.now\(\),/,
      '#vomSidecar muss hostMeldungWeiterreichen(buch, ev, jetzt, senden) aufrufen',
    );
    assert.match(
      quelleVorrang(),
      /import\s*\{[^}]*hostMeldungWeiterreichen[^}]*\}\s*from\s*'\.\/vorrangTakt'/,
      'die Entscheidung muss aus vorrangTakt kommen — sonst prüft der Test oben etwas anderes',
    );
  });

  it('hat genau einen Ausstieg: die Rolle', () => {
    const ausstiege = koerper.match(/return/g) ?? [];
    assert.deepEqual(
      ausstiege.length,
      1,
      `#vomSidecar hat ${ausstiege.length} Ausstiege — erlaubt ist nur die Rollenprüfung. Ist ein Flankenfilter zurückgekehrt? Körper: ${koerper}`,
    );
    assert.match(koerper, /if\(this\.#rolle!=='host'\)return;/);
  });

  it('fasst #aktiv nur zum Setzen an', () => {
    const treffer = koerper.match(/this\.#aktiv/g) ?? [];
    assert.equal(
      treffer.length,
      1,
      `#vomSidecar liest #aktiv — genau das war der Flankenfilter. Körper: ${koerper}`,
    );
    assert.match(koerper, /this\.#aktiv=aktiv;/);
  });
});

/** Der Quelltext von `vorrang.ts`. */
function quelleVorrang(): string {
  return readFileSync(
    join(import.meta.dirname, '..', 'src', 'lib', 'remote', 'vorrang.ts'),
    'utf8',
  );
}

/** Den Körper einer Methode aus `vorrang.ts` holen — ohne Kommentare und ohne
 *  Leerraum, damit der Test an der Form hängt und nicht an der Formatierung. */
function methodenKoerper(name: string): string {
  const quelle = quelleVorrang();
  // Die DEFINITION, nicht der Aufruf: am Zeilenanfang eingerückt und mit
  // Rückgabetyp.
  const treffer = new RegExp(`^\\s*${name}\\([^)]*\\):[^{]*\\{`, 'm').exec(quelle);
  assert.ok(treffer, `${name} in vorrang.ts nicht gefunden — Test mitziehen`);
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

/** `GEDULD_MS` aus `vorrang.ts` lesen — das Modul selbst ist für Nodes
 *  Testläufer unerreichbar (s. Kopf), die Zahl steht aber im Quelltext. */
function geduldAusQuelle(): number {
  const treffer = quelleVorrang().match(/const GEDULD_MS = ([\d_]+);/);
  assert.ok(treffer, 'GEDULD_MS in vorrang.ts nicht gefunden — Test mitziehen');
  return Number(treffer[1].replaceAll('_', ''));
}
