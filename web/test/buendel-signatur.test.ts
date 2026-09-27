import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buendelAnmeldung,
  BuendelUnsigniertFehler,
  BuendelSignaturFehler,
  GeraeteIdentitaetGeaendertFehler
} from '../src/lib/krypto/buendelSignatur.ts';

/** Die Signatur liegt auf der GRENZE zwischen zwei Programmen (veroeffentlichen
 *  hier, pruefen auf dem Absender-Geraet). Ihre kanonische Form ist der Vertrag:
 *  eine veraenderte Feldreihenfolge oder ein fehlendes null liess die Signatur
 *  nur auf EINER Seite passen — alle Nachrichten waeren dann signiert-unlesbar.
 *  Der Test haelt die Form fest, ohne den Bundler oder das WASM-Paket zu
 *  brauchen (importfrei, s. buendelSignatur.ts). */

test('die Anmeldeform ist die festgeordnete Dreierform', () => {
  const form = buendelAnmeldung({
    device_pubkey: 'dev-1',
    curve25519: 'c25519',
    rueckfallschluessel: 'rueck'
  });
  // EXAKT dieser String, Feldreihenfolge inklusive — der WASM-Signierer und
  // der Pruefer muessen denselben sehen.
  assert.equal(form, '{"device_pubkey":"dev-1","curve25519":"c25519","rueckfallschluessel":"rueck"}');
});

test('fehlender Rueckfallschluessel wird als null signiert, nicht weggelassen', () => {
  const form = buendelAnmeldung({
    device_pubkey: 'dev-1',
    curve25519: 'c25519',
    rueckfallschluessel: null
  });
  assert.equal(form, '{"device_pubkey":"dev-1","curve25519":"c25519","rueckfallschluessel":null}');
  assert.equal(
    buendelAnmeldung({ device_pubkey: 'dev-1', curve25519: 'c25519', rueckfallschluessel: null }),
    form,
    'dieselbe Eingabe, dieselbe Form — sonst rockt der Signier-Vergleich'
  );
});

test('Extra-Felder im Eintrag veraendern die Anmeldeform nicht', () => {
  // Claim-Eintraege tragen mehr (einmalschluessel, dauerhaft, ed25519, …) —
  // die Signatur deckt bewusst nur den Kern ab.
  const schmal = buendelAnmeldung({
    device_pubkey: 'dev-1',
    curve25519: 'c25519',
    rueckfallschluessel: null
  });
  const fett = buendelAnmeldung({
    device_pubkey: 'dev-1',
    curve25519: 'c25519',
    rueckfallschluessel: null,
    ...( { einmalschluessel: 'otk', dauerhaft: true } as object )
  });
  assert.equal(schmal, fett);
});

test('die drei Fehlerklassen tragen ihre Namen — die UI deutet darauf', () => {
  for (const [Klasse, name] of [
    [BuendelUnsigniertFehler, 'BuendelUnsigniertFehler'],
    [BuendelSignaturFehler, 'BuendelSignaturFehler'],
    [GeraeteIdentitaetGeaendertFehler, 'GeraeteIdentitaetGeaendertFehler']
  ] as const) {
    const fehler = new Klasse('geraet-7');
    assert.equal(fehler.name, name);
    assert.equal(fehler.geraet, 'geraet-7');
    assert.ok(fehler instanceof Error);
    assert.ok(fehler.message.includes('geraet-7'), 'Meldung nennt das Geraet');
  }
});
