import { test } from 'node:test';
import assert from 'node:assert/strict';

import { lokaleTreffer, LOKALE_SUCHE_LIMIT } from '../src/lib/verlauf/sucheTreffer.ts';

type Satz = {
  kanalId: string;
  nachrichtId: string;
  autorId: string;
  inhalt: string;
  erstelltAm: string;
  geloescht: boolean;
};

function satz(nachrichtId: string, inhalt: string, opts: Partial<Satz> = {}): Satz {
  return {
    kanalId: 'kanal-1',
    nachrichtId,
    autorId: 'user-1',
    inhalt,
    erstelltAm: '2026-08-28T10:00:00Z',
    geloescht: false,
    ...opts
  };
}

test('ohne die lokale Suche wuerde ein Treffer in einer verschluesselten Nachricht NIE gefunden — dies belegt, dass er es jetzt wird', () => {
  // Der Server kennt diese Nachricht nie (sie ging nur ueber /postfach) —
  // GET /dm-channels-search haette hier IMMER [] geliefert. `lokaleTreffer`
  // ist der Ersatz dafuer.
  const saetze = [satz('1', 'das geheime Treffen ist um 20 Uhr')];
  const ergebnis = lokaleTreffer(saetze, 'geheime');
  assert.equal(ergebnis.length, 1);
  assert.equal(ergebnis[0].message_id, '1');
  assert.equal(ergebnis[0].content, 'das geheime Treffen ist um 20 Uhr');
});

test('Gross-/Kleinschreibung spielt keine Rolle (wie server-seitiges ilike)', () => {
  const saetze = [satz('1', 'Hallo Welt')];
  assert.equal(lokaleTreffer(saetze, 'hallo').length, 1);
  assert.equal(lokaleTreffer(saetze, 'WELT').length, 1);
});

test('ein Grabstein wird nie gefunden', () => {
  const saetze = [satz('1', 'geloeschter inhalt', { geloescht: true })];
  assert.equal(lokaleTreffer(saetze, 'geloeschter').length, 0);
});

test('ein zu kurzer Suchbegriff liefert nichts (wie server-seitig min_length=2)', () => {
  const saetze = [satz('1', 'x')];
  assert.equal(lokaleTreffer(saetze, 'x').length, 0);
});

test('Rangfolge: neueste Nachrichten-ID zuerst, ueber beide ID-Schemata hinweg', () => {
  // Lokale ID (20 Stellen, Date.now()=1700000000000 + Zufall) ist AELTER als
  // die Snowflake unten, obwohl sie als rohe Zahl groesser ist — dieselbe
  // Faustregel wie in `verlauf-zusammenfuegen.test.ts`.
  const verschluesseltAelter = satz('17000000000001234567', 'treffer eins');
  const klartextNeuer = satz('20971520000', 'treffer zwei');
  const ergebnis = lokaleTreffer([verschluesseltAelter, klartextNeuer], 'treffer');
  assert.deepEqual(
    ergebnis.map((t) => t.message_id),
    ['20971520000', '17000000000001234567']
  );
});

test('die Obergrenze der Trefferliste wird eingehalten', () => {
  const viele = Array.from({ length: LOKALE_SUCHE_LIMIT + 5 }, (_, i) =>
    satz(String(i + 1), 'treffer')
  );
  assert.equal(lokaleTreffer(viele, 'treffer').length, LOKALE_SUCHE_LIMIT);
});
