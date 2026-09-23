import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  GEHEIM_MARKE,
  entwickleGeheimnis,
  istGeheimWickel,
  wickelGeheimnis
} from '../electron/geheimform.ts';

/** Der reine Kern der safeStorage-Verpackung, ohne Electron: `store.ts`
 *  lässt sich unter Node nicht laden (fährt die App hoch), und genau hier
 *  sitzen die Fallen — ein halb gelesener Wert wäre schlimmer als keiner,
 *  und der Fallback ohne OS-Tresor muss dieselben Werte unverändert
 *  durchreichen. */

/** Stub-Tresor: "verschlüsselt" erkennbar (Präfix), wirft auf Befehl — für
 *  den Schlüsselwechsel-Fall. */
function tresor(geheim: string) {
  return {
    verschluessle: (klar: string) => Buffer.from(`enc(${geheim}):${klar}`),
    entschluessle: (d: Buffer) => {
      const text = d.toString('utf8');
      if (!text.startsWith(`enc(${geheim}):`)) throw new Error('tresor gewechselt');
      return text.slice(`enc(${geheim}):`.length);
    }
  };
}

test('wickeln und entwickeln runden durch', () => {
  const t = tresor('dpapi');
  const creds = { client_secret: 's3cret', relay_tunnel_token: 'plse_relay_abc' };
  const wickel = wickelGeheimnis(JSON.stringify(creds), t.verschluessle);
  assert.equal(wickel.__pulseGeheim, GEHEIM_MARKE);
  assert.equal(typeof wickel.d, 'string');
  // Auf der Platte steht NIE der Klartext — der Wrapper trägt nur den
  // base64-Ziphertext.
  assert.ok(!wickel.d.includes('s3cret'));
  const wert = entwickleGeheimnis<{ client_secret: string }>(wickel, t.entschluessle);
  assert.deepEqual(wert, creds);
});

test('istGeheimWickel unterscheidet Wrapper von echten Werten', () => {
  assert.equal(istGeheimWickel({ __pulseGeheim: 1, d: 'aGk=' }), true);
  // Ein CRED-Objekt des Servers (Host-Backend) kann theoretisch ein Feld
  // mit demselben Namen tragen — ohne Zahl und ohne `d` ist es kein Wrapper.
  assert.equal(istGeheimWickel({ client_secret: 'x' }), false);
  assert.equal(istGeheimWickel({ __pulseGeheim: 2, d: 'aGk=' }), false);
  assert.equal(istGeheimWickel({ __pulseGeheim: 1 }), false);
  assert.equal(istGeheimWickel(null), false);
  assert.equal(istGeheimWickel('klartext'), false);
});

test('gewechselter OS-Tresor ergibt null, keinen Wurf und keinen Halbwert', () => {
  // Der Fall "Profil umgezogen / Schlüssel rotiert": `storeGet` behandelt
  // `null` als verlorenes Geheimnis (verwerfen + Neu-Pairing). Wichtig ist,
  // dass die Funktion hier NICHT wirft und NICHT etwas Halbes zurückgibt.
  const alt = tresor('dpapi');
  const neu = tresor('anderer-schluessel');
  const wickel = wickelGeheimnis(JSON.stringify({ a: 1 }), alt.verschluessle);
  assert.equal(entwickleGeheimnis(wickel, neu.entschluessle), null);
});

test('kaputtes Base64 und kaputtes JSON ergeben ebenfalls null', () => {
  const t = tresor('dpapi');
  assert.equal(
    entwickleGeheimnis({ __pulseGeheim: 1, d: '!!! kein base64' }, t.entschluessle),
    null
  );
  assert.equal(
    entwickleGeheimnis({ __pulseGeheim: 1, d: Buffer.from('kein json').toString('base64') }, t.entschluessle),
    null
  );
});

test('der Klartext-Fallback läuft als normaler Wert durch den Wickel-Test', () => {
  // Ohne OS-Tresor speichert `store.ts` den Wert unverändert; der Leser
  // erkennt an `istGeheimWickel`, dass nichts zu entwickeln ist. Der Test
  // hält fest, dass ein Klartext-CRED-Objekt NIEMALS als Wrapper gilt.
  const creds = { client_secret: 's3cret', relay_tunnel_token: 'plse_relay_abc' };
  assert.equal(istGeheimWickel(creds), false);
});
