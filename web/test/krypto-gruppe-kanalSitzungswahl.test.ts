import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  neuerKanalSitzungState,
  kanalEreignisVerarbeiten,
  mitgliederFuerNaechstesSenden,
  kanalStandUebernehmen,
  sitzungWaehlen
} from '../src/lib/krypto/gruppe/kanalSitzungswahl.ts';

const GUILD = 'guild-1';
const KANAL = 'kanal-1';

let zaehler = 0;
function neueSitzung(): { sitzung: string; sitzungId: string } {
  zaehler += 1;
  return { sitzung: `sitzung-${zaehler}`, sitzungId: `id-${zaehler}` };
}

/** Simuliert eine vollstaendige Sendung: Mitgliederliste holen (oder aus
 *  dem Stand wiederverwenden), Sitzung waehlen, Stand uebernehmen. Gibt
 *  zurueck, wie oft `mitgliederHolen` in diesem einen Schritt lief. */
async function sendeSchritt(
  state: ReturnType<typeof neuerKanalSitzungState<string>>,
  mitgliederliste: string[],
  geraete: string[]
): Promise<{ holAufrufe: number; sitzungId: string; grund: string | null }> {
  let holAufrufe = 0;
  const mitglieder = await mitgliederFuerNaechstesSenden(state, async () => {
    holAufrufe += 1;
    return mitgliederliste;
  });
  const wahl = sitzungWaehlen(state.stand, mitglieder, geraete, neueSitzung, Date.now());
  kanalStandUebernehmen(state, wahl);
  return { holAufrufe, sitzungId: wahl.stand.sitzungId, grund: wahl.grund };
}

test('die erste Sendung holt immer, es gibt noch keinen Stand', async () => {
  const state = neuerKanalSitzungState<string>();
  const erg = await sendeSchritt(state, ['anna', 'bert'], ['g-anna', 'g-bert']);
  assert.equal(erg.holAufrufe, 1);
  assert.equal(erg.grund, 'keine');
});

test('ohne Ereignis wird bei der naechsten Sendung NICHT erneut geholt, und es wird NICHT rotiert', async () => {
  const state = neuerKanalSitzungState<string>();
  const erste = await sendeSchritt(state, ['anna', 'bert'], ['g-anna', 'g-bert']);

  // Absichtlich eine ANDERE Liste uebergeben — sie darf gar nicht erst
  // abgefragt werden, weil kein Ereignis kam. Bliebe hier ein Aufruf,
  // wuerde ein Fehler in `mitgliederFuerNaechstesSenden` unbemerkt bleiben.
  const zweite = await sendeSchritt(state, ['anna', 'bert', 'jemand-anders'], [
    'g-anna',
    'g-bert'
  ]);

  assert.equal(zweite.holAufrufe, 0, 'ohne Ereignis darf nicht neu geholt werden');
  assert.equal(zweite.grund, null, 'ohne Ereignis darf nicht rotiert werden');
  assert.equal(zweite.sitzungId, erste.sitzungId);
});

test('ein Ereignis macht ueberholt: die naechste Sendung holt neu, rotiert aber nur bei echtem Wechsel', async () => {
  const state = neuerKanalSitzungState<string>();
  const erste = await sendeSchritt(state, ['anna', 'bert'], ['g-anna', 'g-bert']);

  kanalEreignisVerarbeiten(
    state,
    { op: 'member_roles_updated', guild_id: GUILD },
    GUILD,
    KANAL
  );

  // Die frische Liste ist zufaellig dieselbe Menge — z. B. eine
  // Rollenaenderung, die die Sicht auf DIESEN Kanal gar nicht betraf.
  const zweite = await sendeSchritt(state, ['bert', 'anna'], ['g-anna', 'g-bert']);
  assert.equal(zweite.holAufrufe, 1, 'nach einem Ereignis wird neu geholt');
  assert.equal(zweite.grund, null, 'gleiche Menge -> keine Rotation, trotz Ereignis');
  assert.equal(zweite.sitzungId, erste.sitzungId);
});

test('ein Beitritt macht ueberholt und die naechste Sendung rotiert wirklich', async () => {
  const state = neuerKanalSitzungState<string>();
  const erste = await sendeSchritt(state, ['anna', 'bert'], ['g-anna', 'g-bert']);

  kanalEreignisVerarbeiten(state, { op: 'guild_member_added', guild_id: GUILD }, GUILD, KANAL);
  const zweite = await sendeSchritt(state, ['anna', 'bert', 'cara'], [
    'g-anna',
    'g-bert',
    'g-cara'
  ]);
  assert.equal(zweite.grund, 'mitgliederwechsel');
  assert.notEqual(zweite.sitzungId, erste.sitzungId);
});

test('ein Austritt macht ueberholt und die naechste Sendung rotiert wirklich', async () => {
  const state = neuerKanalSitzungState<string>();
  const erste = await sendeSchritt(state, ['anna', 'bert'], ['g-anna', 'g-bert']);

  kanalEreignisVerarbeiten(state, { op: 'guild_member_removed', guild_id: GUILD }, GUILD, KANAL);
  const zweite = await sendeSchritt(state, ['anna'], ['g-anna']);
  assert.equal(zweite.grund, 'mitgliederwechsel');
  assert.notEqual(zweite.sitzungId, erste.sitzungId);
});

test('ein Ereignis fuer eine fremde Guild macht nicht ueberholt', async () => {
  const state = neuerKanalSitzungState<string>();
  await sendeSchritt(state, ['anna', 'bert'], ['g-anna', 'g-bert']);

  kanalEreignisVerarbeiten(
    state,
    { op: 'guild_member_added', guild_id: 'andere-guild' },
    GUILD,
    KANAL
  );
  const zweite = await sendeSchritt(state, ['anna', 'bert', 'sollte-nie-gesehen-werden'], [
    'g-anna',
    'g-bert'
  ]);
  assert.equal(zweite.holAufrufe, 0);
  assert.equal(zweite.grund, null);
});

test('channel_permissions_updated fuer einen ANDEREN Kanal macht diesen nicht ueberholt', async () => {
  const state = neuerKanalSitzungState<string>();
  await sendeSchritt(state, ['anna', 'bert'], ['g-anna', 'g-bert']);

  kanalEreignisVerarbeiten(
    state,
    { op: 'channel_permissions_updated', guild_id: GUILD, channel_id: 'anderer-kanal' },
    GUILD,
    KANAL
  );
  const zweite = await sendeSchritt(state, ['anna', 'bert', 'sollte-nie-gesehen-werden'], [
    'g-anna',
    'g-bert'
  ]);
  assert.equal(zweite.holAufrufe, 0);
  assert.equal(zweite.grund, null);
});

test('bricht die Sendung ab, bevor der Stand uebernommen wird, bleibt ueberholt bestehen', async () => {
  const state = neuerKanalSitzungState<string>();
  await sendeSchritt(state, ['anna', 'bert'], ['g-anna', 'g-bert']);

  kanalEreignisVerarbeiten(state, { op: 'guild_member_added', guild_id: GUILD }, GUILD, KANAL);

  // Mitgliederliste wird geholt (weil ueberholt), aber `kanalStandUebernehmen`
  // wird absichtlich NICHT gerufen — simuliert einen Abbruch mitten in der
  // Sendung (Netzfehler beim Verteilen o. ae.).
  let holAufrufe = 0;
  await mitgliederFuerNaechstesSenden(state, async () => {
    holAufrufe += 1;
    return ['anna', 'bert', 'cara'];
  });
  assert.equal(holAufrufe, 1);
  assert.equal(state.ueberholt, true, 'ohne uebernommenen Stand bleibt die Markierung stehen');

  // Der naechste ECHTE Versuch holt deshalb wieder frisch, statt den alten
  // Stand (der die dazwischen gesehene, aber verworfene Liste nie kannte)
  // weiterzuverwenden.
  const wahr = await sendeSchritt(state, ['anna', 'bert', 'cara'], [
    'g-anna',
    'g-bert',
    'g-cara'
  ]);
  assert.equal(wahr.holAufrufe, 1);
  assert.equal(wahr.grund, 'mitgliederwechsel');
});
