/**
 * Bughunt 2026-08-28, Befund 2: `ready.ts` reichte fuer die Frage „ist
 * dieser Kanal gerade abonniert?" fest `() => false` durch (s. `chat.ts`
 * ~106-111 vor dem Fix). Jede beim Verbinden/Reconnect nachgeholte
 * Postfach-Zustellung zaehlte dadurch IMMER als ungelesen — auch in dem
 * Kanal, in dem der Nutzer gerade sitzt — und blieb es, weil `switchTo()`
 * (`web/src/routes/app/@me/[[dmChannelId]]/+page.svelte`) `markRead` nur
 * bei einem Wechsel der `dmChannelId` ruft, nicht bei einem blossen
 * Reconnect im selben Gespraech.
 *
 * Quelltext-Gegenprobe (nicht Laufzeit, s. `krypto-postfach-ready.test.ts`
 * fuer die Begruendung): `ready.ts` darf `postfachAbholenUndAnzeigen` nicht
 * mehr mit einer Konstante aufrufen, sondern muss ueber `ctx.getSubs()` den
 * echten Abo-Stand der dispatchenden Verbindung durchreichen — dieselbe
 * Quelle, die `HandlerContext.subs` speist (`gateway-handlers-
 * bootstrap.ts`). Diese Gegenprobe schlaegt auf dem Stand VOR dem Fix fehl:
 * dort stand dort `postfachAbholenUndAnzeigen(() => false)`.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HIER = dirname(fileURLToPath(import.meta.url));
const readyQuelle = readFileSync(
  join(HIER, '../src/lib/ws/handlers/ready.ts'),
  'utf8'
);
const bootstrapQuelle = readFileSync(
  join(HIER, '../src/lib/ws/gateway-handlers-bootstrap.ts'),
  'utf8'
);

describe('ready.ts reicht den echten Abo-Stand an den Postfach-Nachholvorgang durch', () => {
  it('ruft postfachAbholenUndAnzeigen NICHT mehr mit der Konstante () => false auf', () => {
    assert.doesNotMatch(readyQuelle, /postfachAbholenUndAnzeigen\(\s*\(\)\s*=>\s*false\s*\)/);
  });

  it('ruft sie stattdessen ueber ctx.getSubs() auf', () => {
    assert.match(
      readyQuelle,
      /postfachAbholenUndAnzeigen\(\s*\(\w+\)\s*=>\s*ctx\.getSubs\(\)\.has\(\w+\)\s*\)/
    );
  });

  it('ReadyContext deklariert getSubs', () => {
    assert.match(readyQuelle, /getSubs:\s*\(\)\s*=>\s*Set<string>/);
  });

  it('der Bootstrap reicht deps.getSubs auch an den ready-Zweig durch (nicht nur an HandlerContext)', () => {
    assert.match(bootstrapQuelle, /getSubs:\s*deps\.getSubs/);
  });
});
