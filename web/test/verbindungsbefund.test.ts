/**
 * Die Deutung einer gescheiterten Serververbindung.
 *
 * **Warum es diesen Test gibt.** Der teuerste Ausgang ist nicht „die Deutung
 * ist ungenau", sondern: sie hält einen funktionierenden Server für kaputt und
 * verweigert das Hinzufügen. Ein zu grober Befund kostet den Betreiber eine
 * Stunde Sucherei; ein falsch-negativer kostet ihn den Server. Deshalb prüft
 * dieser Test zuerst, dass ein ANTWORTENDER Gateway immer als „offen" gilt —
 * auch mit einem Schliesscode, den dieser Client noch gar nicht kennt.
 *
 * Der letzte Block hält die Schliesscode-Zahlen textlich gegen
 * `lib/api/constants.ts`. Sie stehen an zwei Stellen, weil `verbindungsbefund.ts`
 * importfrei bleiben muss (nur so erreicht Nodes Testläufer sie überhaupt) —
 * und zwei Stellen driften, wenn niemand sie zusammenhält. Gleiches Muster wie
 * `pulse-player/tests/zwillinge.rs`.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  deuteProbe,
  haeltAuf,
  deuteAbrufFehler,
  deuteNetdiag,
  type Verbindungsbefund,
} from '../src/lib/api/verbindungsbefund.ts';

describe('deuteProbe — was der WebSocket-Probe aussagt', () => {
  it('wertet ein abgelehntes Wegwerf-Token als offene Kette', () => {
    // Der erwünschte Ausgang: der Gateway hat geantwortet. Dass er unser
    // Token ablehnt, war der Zweck der Übung.
    assert.equal(deuteProbe(true, 4001), 'offen');
  });

  it('hält JEDEN 4000er-Code eines antwortenden Gateways für offen', () => {
    // Ein neuerer Server darf nicht als kaputt gelten, nur weil dieser Client
    // seinen Code noch nicht kennt. Dass er ANKAM, ist die Aussage.
    for (const code of [4000, 4009, 4017, 4047, 4099, 4200, 4999]) {
      assert.equal(deuteProbe(true, code), 'offen', `Code ${code} darf nicht aufhalten`);
    }
  });

  it('trennt die vier Ursachen, für die es verschiedene Handlungen gibt', () => {
    assert.equal(deuteProbe(false, 1006), 'kein-upgrade');       // Proxy reicht nicht durch
    assert.equal(deuteProbe(true, 4046), 'server-ohne-cloud');   // ER erreicht die Cloud nicht
    assert.equal(deuteProbe(true, 4070), 'server-gesperrt');     // Cloud hat gesperrt
    assert.equal(deuteProbe(true, 4044), 'server-zu-alt');
  });

  it('unterscheidet „kam nicht durch" von „kam durch, aber niemand sprach Pulse"', () => {
    // Ohne open: der Upgrade selbst scheiterte — das ist der Proxy.
    assert.equal(deuteProbe(false, 1006), 'kein-upgrade');
    assert.equal(deuteProbe(false, 4001), 'kein-upgrade');
    // Mit open, aber unsauberem Ende: der Upgrade kam durch, es antwortete
    // nur kein Gateway. Andere Stelle, andere Handlung.
    assert.equal(deuteProbe(true, 1006), 'kein-gateway');
    assert.equal(deuteProbe(true, 1005), 'kein-gateway');
    assert.equal(deuteProbe(true, 1000), 'kein-gateway');
  });

  it('meldet Zeitablauf als eigenen Fall, nicht als Proxy-Fehler', () => {
    // Ein Zeitablauf sagt NICHT, dass der Upgrade scheiterte — er sagt gar
    // nichts. Ihn zu „kein-upgrade" zu schlagen wäre eine erfundene Diagnose.
    assert.equal(deuteProbe(false, null), 'zeitueberschreitung');
    assert.equal(deuteProbe(true, null), 'zeitueberschreitung');
  });
});

describe('haeltAuf — was das Hinzufügen verhindern darf', () => {
  it('lässt die offene Kette durch', () => {
    assert.equal(haeltAuf('offen'), false);
  });

  it('überlässt Sperre und Alter den Wegen, die genauere Texte haben', () => {
    // Beide meldet der Cert-Login bzw. der Versionsvergleich ohnehin, und zwar
    // konkreter. Hier gemeldet stünden sie doppelt und widersprüchlich da.
    assert.equal(haeltAuf('server-gesperrt'), false);
    assert.equal(haeltAuf('server-zu-alt'), false);
  });

  it('hält alles auf, was der Nutzer sonst erst nach dem Beitritt merkte', () => {
    for (const b of [
      'kein-upgrade',
      'kein-gateway',
      'server-ohne-cloud',
      'zeitueberschreitung',
    ] as Verbindungsbefund[]) {
      assert.equal(haeltAuf(b), true, `${b} muss aufhalten`);
    }
  });
});

describe('deuteAbrufFehler — CORS von totem Netz trennen', () => {
  it('nennt eine opaque Gegenantwort beim Namen: der Server steht', () => {
    // Genau das kann der Browser aus dem TypeError allein nicht sagen.
    assert.equal(deuteAbrufFehler(true), 'cors');
  });

  it('bleibt ohne Gegenantwort bei „nicht erreichbar"', () => {
    assert.equal(deuteAbrufFehler(false), 'unreachable');
  });
});

describe('Zwillinge — die Schliesscodes stehen an zwei Stellen', () => {
  it('nennt dieselben Zahlen wie constants.ts', () => {
    const hier = readFileSync(
      join(import.meta.dirname, '../src/lib/api/verbindungsbefund.ts'),
      'utf8',
    );
    const dort = readFileSync(
      join(import.meta.dirname, '../src/lib/api/constants.ts'),
      'utf8',
    );

    // Paare: der Name hier, der Name in constants.ts.
    const paare: Array<[string, string]> = [
      ['TOKEN_ABGELEHNT', 'TOKEN_EXPIRED'],
      ['SERVER_ZU_ALT', 'SERVER_TOO_OLD'],
      ['JWKS_KALT', 'JWKS_NOT_READY'],
      ['INSTANZ_GESPERRT', 'INSTANCE_SUSPENDED'],
    ];

    const zahl = (quelle: string, name: string): string => {
      const treffer = quelle.match(new RegExp(`${name}\\s*:\\s*(\\d{4})`));
      assert.ok(treffer, `${name} nicht gefunden — wurde er umbenannt?`);
      return treffer[1];
    };

    for (const [a, b] of paare) {
      assert.equal(
        zahl(hier, a),
        zahl(dort, b),
        `${a} (verbindungsbefund.ts) und ${b} (constants.ts) sind auseinandergelaufen`,
      );
    }
  });
});

describe('deuteNetdiag — die genaue Auskunft aus dem Desktop', () => {
  it('nennt den Schritt, an dem die Kette abbrach', () => {
    assert.equal(deuteNetdiag([{ schritt: 'dns', ok: false }]), 'name-unbekannt');
    assert.equal(
      deuteNetdiag([{ schritt: 'dns', ok: true }, { schritt: 'tcp', ok: false }]),
      'port-zu',
    );
  });

  it('trennt die Zertifikatsfälle, die verschiedene Handlungen haben', () => {
    const bisTls = (befund: string) => [
      { schritt: 'dns', ok: true },
      { schritt: 'tcp', ok: true },
      { schritt: 'tls', ok: false, befund },
    ];
    assert.equal(deuteNetdiag(bisTls('falscher-name')), 'zert-name');
    assert.equal(deuteNetdiag(bisTls('abgelaufen')), 'zert-abgelaufen');
    assert.equal(deuteNetdiag(bisTls('selbstsigniert')), 'zert-ungueltig');
    assert.equal(deuteNetdiag(bisTls('kette-unvollstaendig')), 'zert-ungueltig');
  });

  it('erfindet nichts, wo nichts gemessen wurde', () => {
    // Der teure Fehler wäre hier nicht Ungenauigkeit, sondern eine erfundene
    // Ursache: der Betreiber sucht dann an der falschen Stelle.
    assert.equal(deuteNetdiag(null), null);
    assert.equal(deuteNetdiag([]), null);
    assert.equal(deuteNetdiag([{ schritt: 'tls', ok: false, befund: 'unbekannter-fehler' }]), null);
  });

  it('gibt für eine durchgehend grüne Kette nichts zurück', () => {
    // Steht alles bis HTTP und der Browser scheiterte trotzdem, ist es ein
    // CORS-Fall — der hat seinen eigenen Weg und seine eigene Meldung.
    assert.equal(
      deuteNetdiag([
        { schritt: 'dns', ok: true },
        { schritt: 'tcp', ok: true },
        { schritt: 'tls', ok: true },
        { schritt: 'http', ok: true },
      ]),
      null,
    );
  });

  it('hält ein bald ablaufendes Zertifikat NICHT für einen Grund aufzuhalten', () => {
    assert.equal(deuteNetdiag([{ schritt: 'tls', ok: false, befund: 'laeuft-bald-ab' }]), null);
  });
});
