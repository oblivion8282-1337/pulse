/**
 * Bughunt 2026-09-20: drei Wege, auf denen Daten des VORGÄNGER-Kontos nach
 * dem Abmelden in den Stores landen konnten, plus der Notification-Klick,
 * der sein url-Ziel verschluckte. Die Laufzeit ist im Node-Läufer nicht
 * erreichbar (Svelte-Runes-Importkegel, s. sicherung-anschluss.test.ts),
 * deshalb Quelltext-Gegenproben — jede schlägt auf dem Stand VOR dem Fix fehl.
 *
 *   Leck 1: `privateGruppen.clear()` hatte keinen einzigen Aufrufer —
 *     `resetSocialStores()` ließ den Store stehen, Account B sah A's Gruppen.
 *   Leck 2: `directMessages.hydrate()`/`guilds.loadChannels()` schrieben ihre
 *     Antwort bedingungslos zurück — eine in-flight Antwort nach dem
 *     Abmelden füllte den geleerten Store wieder auf.
 *   Leck 3: `_dial()` prüfte `wantConnected` nach den Awaits nicht — ein
 *     Zombie-Socket überlebte `closeAll()` und sein ready-Frame befüllte
 *     die geleerten Stores.
 *   Leck 4: der SW-message-Handler verlangte `channel_id` und las `url`
 *     nie — Freund-Events (nur target_url) fokussierten den Tab, ohne zu
 *     navigieren.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HIER = dirname(fileURLToPath(import.meta.url));
const lese = (rel: string) => readFileSync(join(HIER, '..', rel), 'utf8');

const resetQuelle = lese('src/lib/stores/multi-server-reset.ts');
const dmQuelle = lese('src/lib/stores/directMessages.svelte.ts');
const guildsQuelle = lese('src/lib/stores/guilds.svelte.ts');
const dialQuelle = lese('src/lib/ws/gateway-connection.ts');
const layoutQuelle = lese('src/routes/app/+layout.svelte');

describe('Bughunt 2026-09-20: Konto-Wechsel leakt nicht in die Stores', () => {
  it('resetSocialStores räumt die privaten Gruppen mit ab', () => {
    const social = resetQuelle.indexOf('export function resetSocialStores');
    assert.ok(social >= 0);
    assert.ok(
      resetQuelle.indexOf('privateGruppen.clear()', social) > social,
      'privateGruppen.clear() muss in resetSocialStores stehen (Sign-Out/Account-Wechsel)'
    );
  });

  it('directMessages.hydrate() verwirft Antworten, die nach einem clear() eintreffen', () => {
    const hydrate = dmQuelle.indexOf('async hydrate()');
    assert.ok(hydrate >= 0, 'Anker hydrate() muss gefunden werden');
    const guard = dmQuelle.indexOf('generation !== this.#generation', hydrate);
    assert.ok(guard > hydrate, 'hydrate muss den Generation-Guard haben');
    const clear = dmQuelle.indexOf('clear()');
    assert.ok(clear >= 0, 'Anker clear() muss gefunden werden');
    assert.ok(
      dmQuelle.indexOf('#generation++', clear) > clear,
      'clear() muss die Generation hochzählen'
    );
  });

  it('guilds.loadChannels()/hydrate() verwirft Antworten nach einem clear()', () => {
    const hydrate = guildsQuelle.indexOf('async hydrate()');
    assert.ok(hydrate >= 0, 'Anker hydrate() muss gefunden werden');
    assert.ok(
      guildsQuelle.indexOf('generation !== this.#generation', hydrate) > hydrate,
      'hydrate muss den Generation-Guard haben'
    );
    const lade = guildsQuelle.indexOf('async loadChannels(');
    assert.ok(lade >= 0, 'Anker loadChannels muss gefunden werden');
    assert.ok(
      guildsQuelle.indexOf('generation !== this.#generation', lade) > lade,
      'loadChannels muss den Generation-Guard haben'
    );
  });

  it('_dial() schließt den Socket, wenn disconnect() während der Anbahnung lief', () => {
    const dial = dialQuelle.indexOf('private async _dial()');
    assert.ok(dial >= 0, 'Anker _dial() muss gefunden werden');
    const nachOeffnen = dialQuelle.indexOf('await this._openSocket(token)', dial);
    assert.ok(nachOeffnen >= 0, 'Anker _openSocket muss gefunden werden');
    const wächter = dialQuelle.indexOf('if (!this.wantConnected) {', nachOeffnen);
    assert.ok(
      wächter > nachOeffnen,
      'nach _openSocket muss wantConnected erneut geprüft werden (Zombie-Socket)'
    );
  });

  it('SW-navigateTo reicht auch das reine url-Ziel durch (Freund-Events)', () => {
    const handler = layoutQuelle.indexOf("data?.type === 'navigateTo'");
    assert.ok(handler >= 0);
    assert.ok(
      layoutQuelle.indexOf('data.url', handler) > handler,
      'der SW-message-Handler muss data.url an navigateToFromNotification übergeben'
    );
  });
});
