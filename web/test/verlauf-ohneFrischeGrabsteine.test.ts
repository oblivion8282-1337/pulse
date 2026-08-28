import { test } from 'node:test';
import assert from 'node:assert/strict';

// FIX 3 (Bughunt 2026-08-28): ein un-awaiteter Hintergrund-Abgleich
// (`nachladen.ts::reconciliereAeltereSeite`) darf einen frisch entstandenen
// lokalen Grabstein nicht wieder auf "nicht geloescht" zuruecksetzen, nur
// weil seine (waehrenddessen unterwegs gewesene) Serverantwort die Loeschung
// noch nicht kennt. Geprueft wird die importfreie Filterentscheidung, s.
// deren Modulkopf, warum nicht `nachladen.ts` direkt.
import { ohneFrischeGrabsteine } from '../src/lib/verlauf/ohneFrischeGrabsteine.ts';

function nachricht(id: string) {
  return { id, content: `inhalt-${id}` };
}

test('eine waehrend der Anfrage frisch geloeschte Nachricht wird aus der Serverantwort entfernt', () => {
  const vomServer = [nachricht('a'), nachricht('b'), nachricht('c')];
  const ergebnis = ohneFrischeGrabsteine(vomServer, new Set(['b']));
  assert.deepEqual(
    ergebnis.map((n) => n.id),
    ['a', 'c']
  );
});

test('ohne frische Grabsteine bleibt die Serverantwort unveraendert (selbe Referenzen)', () => {
  const vomServer = [nachricht('a'), nachricht('b')];
  const ergebnis = ohneFrischeGrabsteine(vomServer, new Set());
  assert.equal(ergebnis, vomServer);
});

test('nimmt auch ein einfaches Array statt eines Sets an', () => {
  const vomServer = [nachricht('a'), nachricht('b')];
  const ergebnis = ohneFrischeGrabsteine(vomServer, ['a']);
  assert.deepEqual(
    ergebnis.map((n) => n.id),
    ['b']
  );
});

test('ein Grabstein fuer eine ID, die gar nicht in der Serverantwort steht, aendert nichts', () => {
  const vomServer = [nachricht('a')];
  const ergebnis = ohneFrischeGrabsteine(vomServer, new Set(['nie-gesehen']));
  assert.deepEqual(
    ergebnis.map((n) => n.id),
    ['a']
  );
});
