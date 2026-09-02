import { test } from 'node:test';
import assert from 'node:assert/strict';

import { sucheZusammenfuehren } from '../src/lib/verlauf/sucheZusammenfuehren.ts';

type Treffer = {
  message_id: string;
  dm_channel_id: string;
  author_id: string;
  content: string;
  created_at: string;
};

function treffer(dmChannelId: string, messageId: string, content = 'hallo'): Treffer {
  return {
    message_id: messageId,
    dm_channel_id: dmChannelId,
    author_id: 'user-1',
    content,
    created_at: '2026-08-28T10:00:00Z'
  };
}

test('ein Treffer, den beide Quellen liefern, erscheint genau einmal', () => {
  // Ohne den Fix (naives [...lokal, ...vomServer]) waere die Liste hier 2
  // lang — belegt: eine unverschluesselte Nachricht, die seit C1 zusaetzlich
  // lokal abgelegt wurde, taucht in BEIDEN Quellen unter derselben
  // dm_channel_id+message_id auf.
  const lokal = [treffer('kanal-1', '5', 'dasselbe')];
  const vomServer = [treffer('kanal-1', '5', 'dasselbe')];
  const ergebnis = sucheZusammenfuehren(lokal, vomServer, 20);
  assert.equal(ergebnis.length, 1);
});

test('lokal gewinnt bei einem Doppel', () => {
  const lokal = [treffer('kanal-1', '5', 'lokale fassung')];
  const vomServer = [treffer('kanal-1', '5', 'server fassung')];
  const ergebnis = sucheZusammenfuehren(lokal, vomServer, 20);
  assert.equal(ergebnis.length, 1);
  assert.equal(ergebnis[0].content, 'lokale fassung');
});

test('dieselbe message_id in verschiedenen Kanaelen ist KEIN Doppel', () => {
  const lokal = [treffer('kanal-1', '5')];
  const vomServer = [treffer('kanal-2', '5')];
  const ergebnis = sucheZusammenfuehren(lokal, vomServer, 20);
  assert.equal(ergebnis.length, 2);
});

test('ein rein serverseitiger Treffer (alte, unverschluesselte Nachricht) bleibt erhalten', () => {
  const lokal: Treffer[] = [];
  const vomServer = [treffer('kanal-1', '5')];
  const ergebnis = sucheZusammenfuehren(lokal, vomServer, 20);
  assert.equal(ergebnis.length, 1);
});

test('Rangfolge nach dem Zusammenfuehren: neueste Nachrichten-ID zuerst', () => {
  const lokal = [treffer('kanal-1', '17000000000001234567')]; // lokale ID, "aelter"
  const vomServer = [treffer('kanal-1', '20971520000')]; // Snowflake, "neuer"
  const ergebnis = sucheZusammenfuehren(lokal, vomServer, 20);
  assert.deepEqual(
    ergebnis.map((t) => t.message_id),
    ['20971520000', '17000000000001234567']
  );
});

test('die Obergrenze gilt nach dem Zusammenfuehren, nicht je Quelle', () => {
  const lokal = [treffer('kanal-1', '1'), treffer('kanal-1', '2')];
  const vomServer = [treffer('kanal-1', '3'), treffer('kanal-1', '4')];
  const ergebnis = sucheZusammenfuehren(lokal, vomServer, 3);
  assert.equal(ergebnis.length, 3);
});
