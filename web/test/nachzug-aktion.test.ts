import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nachzugAktion, nachzugFuer } from '../src/lib/devices/nachzugAktion.ts';

test('fremdes Geraet (keine eigene Eintragung mit dieser Kennung) → nichts tun', () => {
  assert.equal(
    nachzugAktion({ hatEintragung: false, entfernt: false, umzug: false, unveraendert: false }),
    'nichts',
  );
});

test('fremdes Geraet, obendrein entfernt → bleibt trotzdem nichts tun', () => {
  // Der Frühausstieg ist UNBEDINGT — auch ein removed:true über ein fremdes
  // Gerät darf diesen Rechner nicht anfassen.
  assert.equal(
    nachzugAktion({ hatEintragung: false, entfernt: true, umzug: false, unveraendert: false }),
    'nichts',
  );
});

test('eigenes Geraet, removed → vergessen', () => {
  assert.equal(
    nachzugAktion({ hatEintragung: true, entfernt: true, umzug: false, unveraendert: false }),
    'vergessen',
  );
});

test('eigenes Geraet, andere Community als lokal gemerkt → nachziehen', () => {
  assert.equal(
    nachzugAktion({ hatEintragung: true, entfernt: false, umzug: false, unveraendert: false }),
    'nachziehen',
  );
});

test('eigenes Geraet, unveraendert → nichts zu tun', () => {
  assert.equal(
    nachzugAktion({ hatEintragung: true, entfernt: false, umzug: false, unveraendert: true }),
    'nichts',
  );
});

// K-1 (Prüfbefund 2026-08-20): die Abmeldung an den alten Standplatz beim
// Umstellen trägt `moved: true` und darf die Eintragung NICHT löschen — sonst
// wäre sie von einem echten Löschen nicht unterscheidbar.
test('eigenes Geraet, entfernt+umzug → nichts tun (kein Löschen bei Umzug)', () => {
  assert.equal(
    nachzugAktion({ hatEintragung: true, entfernt: true, umzug: true, unveraendert: false }),
    'nichts',
  );
});

test('eigenes Geraet, entfernt+umzug bleibt nichts tun, selbst wenn unveraendert faelschlich true waere', () => {
  // Verteidigung gegen eine Regression: `umzug` sticht, bevor `unveraendert`
  // überhaupt geprüft wird.
  assert.equal(
    nachzugAktion({ hatEintragung: true, entfernt: true, umzug: true, unveraendert: true }),
    'nichts',
  );
});

// **Test AM AUFRUFORT** (K-1): die beiden Meldungen, wie sie beim Umstellen
// WIRKLICH in dieser Reihenfolge eintreffen — erst die Abmeldung an den alten
// Standplatz mit `umzug: true`, direkt gefolgt von der Änderungsmeldung mit
// dem neuen Standplatz. `nachzugFuer` ist die Entscheidung, wie sie der
// WS-Handler (`ws/handlers/devices.ts`) tatsächlich aufruft — der Handler
// selbst ist ohne Browser nicht testbar (`$state`-Runes, echte WS-Verbindung),
// diese Funktion trägt deshalb seine ganze Abgleichslogik gegen die lokale
// Eintragungsliste.
test('Aufrufort: Umzug-Abmeldung gefolgt von der Änderungsmeldung — die Eintragung steht am Ende und trägt die neue Community', () => {
  let eintragungen = [{ deviceId: 'd1', guildId: 'alt', name: 'werkstatt-pc' }];

  // 1. Die Abmeldung an den ALTEN Standplatz (`entfernt: true, umzug: true`,
  //    trägt noch die alte Community/den alten Namen in der Nutzlast).
  const ersteAktion = nachzugFuer(
    { deviceId: 'd1', guildId: 'alt', name: 'werkstatt-pc', entfernt: true, umzug: true },
    eintragungen,
  );
  assert.equal(ersteAktion, 'nichts', 'ein Umzug darf die Eintragung nicht räumen');
  // 'nichts' verändert die Liste nicht — simuliert den Handler, der bei
  // 'nichts' keine Methode auf `geraeteAnmeldung` ruft.

  // 2. Die unmittelbar folgende Änderungsmeldung mit dem NEUEN Standplatz
  //    (`entfernt: false`).
  const zweiteAktion = nachzugFuer(
    { deviceId: 'd1', guildId: 'neu', name: 'werkstatt-pc', entfernt: false, umzug: false },
    eintragungen,
  );
  assert.equal(zweiteAktion, 'nachziehen', 'die neue Community weicht ab, muss nachgezogen werden');

  // Simuliert, was `geraeteAnmeldung.nachziehen()` tatsächlich tut.
  eintragungen = eintragungen.map((e) =>
    e.deviceId === 'd1' ? { ...e, guildId: 'neu', name: 'werkstatt-pc' } : e,
  );

  assert.deepEqual(eintragungen, [{ deviceId: 'd1', guildId: 'neu', name: 'werkstatt-pc' }]);

  // 3. Eine dritte, überflüssige Wiederholung derselben Änderungsmeldung
  //    (z. B. eine zweite Verbindung desselben Kontos) darf danach nichts
  //    mehr tun — die Eintragung ist schon auf dem neuesten Stand.
  const dritteAktion = nachzugFuer(
    { deviceId: 'd1', guildId: 'neu', name: 'werkstatt-pc', entfernt: false, umzug: false },
    eintragungen,
  );
  assert.equal(dritteAktion, 'nichts');
});

test('Aufrufort: eine Meldung über ein fremdes Geraet greift trotz umzug nie', () => {
  const eintragungen = [{ deviceId: 'd1', guildId: 'alt', name: 'werkstatt-pc' }];
  const aktion = nachzugFuer(
    { deviceId: 'fremd', guildId: 'alt', name: 'irgendwas', entfernt: true, umzug: true },
    eintragungen,
  );
  assert.equal(aktion, 'nichts');
});
