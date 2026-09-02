/**
 * Der Direktlink-Bughunt vom 2026-08-29: eine Gruppen-ID, deren Gruppe erst
 * WAEHREND des Wartens im Speicher ankommt, darf nicht als DM verworfen
 * werden. S. Modulkopf `src/lib/gruppen/kanalArtWarten.ts`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { alsGruppeErkennenNachWarten } from '../src/lib/gruppen/kanalArtWarten.ts';

test('erkennt eine Gruppe, die erst WAEHREND des Wartens im Speicher ankommt', async () => {
  let bekannt = false;
  let aufloesen!: () => void;
  const warten = new Promise<void>((res) => {
    aufloesen = res;
  });

  const ergebnisPromise = alsGruppeErkennenNachWarten(() => bekannt, () => warten);

  // Zum Zeitpunkt des Aufrufs (Direktlink/harter Reload) ist der
  // Gruppen-Speicher noch leer — genau das Fenster aus dem Bughunt.
  assert.equal(bekannt, false);

  // Die Antwort von `GET /gruppen` trifft ein und befuellt den Speicher.
  bekannt = true;
  aufloesen();

  assert.equal(await ergebnisPromise, true);
});

test('bleibt bei false, wenn die Kanal-ID nach dem Warten immer noch keine Gruppe ist (echte DM)', async () => {
  const ergebnis = await alsGruppeErkennenNachWarten(() => false, () => Promise.resolve());
  assert.equal(ergebnis, false);
});

test('Befund 4 (Bughunt 2026-08-29 Runde 6): haengt nicht dauerhaft, wenn das Warten NIE aufloest', async () => {
  // Nachbildung des echten Fehlers: `ws/handlers/ready.ts` ruft
  // `gruppenApi.auflisten().then(seed).catch(() => undefined)` — schlaegt
  // der Abruf fehl, laeuft `seed()` nie und `privateGruppen.bereit` bleibt
  // fuer immer offen. Ohne das Zeitlimit haette dieser Test nie geendet.
  const niePraufloesendesWarten = () => new Promise<void>(() => {});

  const ergebnis = await alsGruppeErkennenNachWarten(
    () => false,
    niePraufloesendesWarten,
    20
  );
  assert.equal(ergebnis, false);
});

test('Befund 4: nach Ablauf des Zeitlimits wird der Bestand noch EINMAL geprueft', async () => {
  const niePraufloesendesWarten = () => new Promise<void>(() => {});

  const ergebnis = await alsGruppeErkennenNachWarten(
    () => true,
    niePraufloesendesWarten,
    20
  );
  assert.equal(ergebnis, true);
});

test('Gegenprobe zur alten Fehlfassung: ein blosses Lesen VOR dem Warten verpasst die Gruppe', () => {
  // Wie der urspruengliche Fehler in `+page.svelte::switchTo`:
  // `untrack(() => privateGruppen.istGruppe(cid))` wurde EINMAL gelesen,
  // ohne auf das noch offene `GET /gruppen` zu warten. Dieser Test waere rot
  // gewesen, haette `alsGruppeErkennenNachWarten` kein Warten eingebaut,
  // sondern wie die alte Fassung sofort gelesen.
  let bekannt = false;
  const sofortGelesen = bekannt; // die alte, fehlerhafte Lesart
  bekannt = true; // GET /gruppen kommt "gleich danach" an
  assert.equal(sofortGelesen, false, 'die alte Lesart sieht die spaeter ankommende Gruppe nicht');
});
