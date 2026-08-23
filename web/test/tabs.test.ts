/**
 * Tests fuer die Pfad-Rechnung der vier mobilen Bereiche
 * (`src/lib/navigation/tabs.ts`).
 *
 * **Warum diese Rechnung Tests verdient:** sie entscheidet zwei Dinge, deren
 * Fehler man von aussen kaum als Fehler erkennt — welcher Bereich unten
 * hervorgehoben ist, und ob die Bereichs-Leiste ueberhaupt sichtbar sein darf.
 * Ist die zweite Antwort falsch, sitzt die Leiste ueber dem Nachrichtenfeld
 * eines offenen Chats, und das sieht nach einem Layout-Fehler aus, nicht nach
 * einer falschen Fallunterscheidung. Der Fall, der am leichtesten kippt, ist
 * die Kanal-Route: sie liegt unter `/app/guilds/...`, gehoert aber zum Bereich
 * „Raeume" — wer nur auf das erste Pfadsegment schaut, verliert dort die
 * Hervorhebung.
 *
 * Ausgefuehrt mit Nodes eingebautem Testlaeufer: `pnpm test:unit`.
 * `tabs.ts` hat deshalb **keinen einzigen Laufzeit-Import** — die Web-Quellen
 * importieren erweiterungslos (`from './nachbar'`), was der Bundler aufloest
 * und Node nicht. Das ist eine Bedingung an das Modul, keine Beobachtung.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BEREICHE, aktiverBereich, istDetailScreen } from '../src/lib/navigation/tabs.ts';

describe('aktiverBereich', () => {
  it('trifft die vier Listen-Pfade', () => {
    assert.equal(aktiverBereich('/app/@me'), 'chats');
    assert.equal(aktiverBereich('/app/rooms'), 'rooms');
    assert.equal(aktiverBereich('/app/friends'), 'friends');
    assert.equal(aktiverBereich('/app/me'), 'me');
  });

  it('ordnet die Kanal-Route den Raeumen zu, nicht den Chats', () => {
    assert.equal(aktiverBereich('/app/guilds/12/channels/34'), 'rooms');
  });

  it('ordnet Entdecken den Raeumen zu', () => {
    assert.equal(aktiverBereich('/app/discover'), 'rooms');
  });

  it('unterscheidet /app/me von /app/@me', () => {
    assert.equal(aktiverBereich('/app/me'), 'me');
    assert.equal(aktiverBereich('/app/@me'), 'chats');
    assert.equal(aktiverBereich('/app/me/appearance'), 'me');
    assert.equal(aktiverBereich('/app/@me/34'), 'chats');
  });

  it('gibt null fuer alles, was zu keinem Bereich gehoert', () => {
    assert.equal(aktiverBereich('/app/admin'), null);
    assert.equal(aktiverBereich('/app/dev/stream'), null);
    assert.equal(aktiverBereich('/login'), null);
    assert.equal(aktiverBereich('/'), null);
    assert.equal(aktiverBereich(''), null);
  });

  it('laesst sich von einem Namen nicht taeuschen, der nur so anfaengt', () => {
    // `/app/roomsomething` ist kein Unterpfad von `/app/rooms` — ein
    // reiner startsWith-Vergleich ohne Segmentgrenze faellt genau hier um.
    assert.equal(aktiverBereich('/app/roomsomething'), null);
    assert.equal(aktiverBereich('/app/friendsxyz'), null);
  });

  it('ignoriert einen nachlaufenden Schraegstrich', () => {
    assert.equal(aktiverBereich('/app/rooms/'), 'rooms');
    assert.equal(aktiverBereich('/app/@me/'), 'chats');
  });
});

describe('istDetailScreen', () => {
  it('ist falsch auf allen Listen-Ebenen', () => {
    for (const pfad of ['/app/@me', '/app/rooms', '/app/friends', '/app/me']) {
      assert.equal(istDetailScreen(pfad), false, pfad);
    }
  });

  it('zaehlt Entdecken als Detail, obwohl es eine eigene Wurzel ist', () => {
    // Man kommt aus dem Raeume-Bereich dorthin und mit dem Pfeil zurueck —
    // Zurueck-Pfeil und Bereichs-Leiste gleichzeitig waeren zwei Aussagen
    // darueber, wo man ist.
    assert.equal(istDetailScreen('/app/discover'), true);
    assert.equal(aktiverBereich('/app/discover'), 'rooms');
  });

  it('ist wahr, sobald ein Detail geoeffnet ist', () => {
    assert.equal(istDetailScreen('/app/@me/34'), true);
    assert.equal(istDetailScreen('/app/guilds/12/channels/34'), true);
    assert.equal(istDetailScreen('/app/me/appearance'), true);
  });

  it('die Community-Übersicht ist KEIN Detail — die Leiste bleibt', () => {
    // Bewusste Entscheidung aus dem Design-Durchgang (9bb5f838): Unter
    // `/app/rooms/<guildId>` verschwindet die Bereichs-Leiste nicht, erst die
    // Kanäle darunter sind Details. Dieser Test hielt bis zum 2026-08-24 noch
    // die ältere Erwartung aus 6fb08399 und war seit 9bb5f838 rot —
    // aufgefallen am ship-Gate, das seitdem jeden Push stoppte.
    assert.equal(istDetailScreen('/app/rooms/12'), false);
  });

  it('ignoriert einen nachlaufenden Schraegstrich', () => {
    // Ohne Normalisierung waere `/app/rooms/` ein Detail-Screen mit leerem
    // Namen — die Leiste verschwaende beim blossen Anhaengen eines Strichs.
    assert.equal(istDetailScreen('/app/rooms/'), false);
    assert.equal(istDetailScreen('/app/@me/'), false);
  });

  it('ist falsch fuer Pfade ausserhalb der Bereiche', () => {
    assert.equal(istDetailScreen('/app/admin/users'), false);
    assert.equal(istDetailScreen('/login'), false);
  });
});

describe('BEREICHE', () => {
  it('haelt genau die vier Bereiche in Anzeigereihenfolge', () => {
    assert.deepEqual(
      BEREICHE.map((b) => b.id),
      ['chats', 'rooms', 'friends', 'me']
    );
  });

  it('jedes Ziel wird von aktiverBereich auf seinen eigenen Bereich zurueckgefuehrt', () => {
    // Haelt Liste und Rechnung zusammen: ein neues Ziel, das die Rechnung
    // nicht kennt, wuerde die Leiste ohne Hervorhebung dastehen lassen.
    for (const bereich of BEREICHE) {
      assert.equal(aktiverBereich(bereich.href), bereich.id, bereich.href);
    }
  });
});
