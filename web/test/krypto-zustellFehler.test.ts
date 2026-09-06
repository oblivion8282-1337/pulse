import { test } from 'node:test';
import assert from 'node:assert/strict';

import { wurdeZugestellt, deuteEinliefernFehler } from '../src/lib/krypto/zustellErgebnis.ts';

// Bughunt 2026-08-28, zweiter Fund: ein aktualisierter Klient gegen einen
// noch nicht aktualisierten Server durchlaeuft `POST /postfach` auf drei
// verschiedene Arten. Jede braucht eine eigene, bewusste Behandlung —
// keine davon darf stillschweigend zu "unverschluesselt senden" fuehren,
// obwohl die verschluesselte Zustellung schon geschehen sein kann.

test('Fall 204 (koerperloser 2xx, undefined): gilt als ZUGESTELLT', () => {
  // `../api/client.ts::parseResponse` macht aus 204 `undefined`. Vorher warf
  // `wurdeZugestellt(undefined)` (TypeError beim Lesen von
  // `.zustellungen_angelegt`) — dieser Test haelt die Reparatur fest.
  assert.equal(wurdeZugestellt(undefined), true);
});

test('Fall 404 (Route fehlt): gilt als sicher UNVERSCHLUESSELT, nicht als unerwarteter Fehler', () => {
  // Eine nicht existierende Route hat nichts entgegengenommen — es kann
  // keine Zustellung entstanden sein. Der Klartext-Rueckfall ist hier
  // beweisbar sicher (kein Duplikat moeglich).
  assert.equal(deuteEinliefernFehler(404), 'unverschluesselt');
});

test('Fall unerwarteter Fehler (5xx/Netzwerk): NICHT als unverschluesselt gedeutet', () => {
  // Der Server hat den Request womoeglich verarbeitet, nur die Antwort ging
  // verloren — ob eine Zustellung entstand, ist hier UNBEKANNT. Ein
  // automatischer Klartext-Rueckfall koennte ein Duplikat erzeugen, deshalb
  // muss dieser Fall von 404 unterscheidbar bleiben.
  assert.equal(deuteEinliefernFehler(500), 'unerwartet');
  assert.equal(deuteEinliefernFehler(0), 'unerwartet'); // Netzwerkfehler (kein HTTP-Status)
  assert.equal(deuteEinliefernFehler(429), 'unerwartet');
});

test('normaler Erfolg mit Zaehler bleibt unveraendert', () => {
  assert.equal(
    wurdeZugestellt({
      zustellungen_angelegt: 1,
      uebersprungene_empfaenger: [],
      verworfene_nutzlasten: 0
    }),
    true
  );
  assert.equal(
    wurdeZugestellt({
      zustellungen_angelegt: 0,
      uebersprungene_empfaenger: ['geraet-a'],
      verworfene_nutzlasten: 1
    }),
    false
  );
});
