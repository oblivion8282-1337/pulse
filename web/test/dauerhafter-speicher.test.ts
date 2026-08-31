import { test } from 'node:test';
import assert from 'node:assert/strict';

/**
 * `dauerhafterSpeicher.ts` merkt sein Ergebnis in einer Modulvariablen — je
 * Sitzung wird hoechstens einmal gefragt. Fuer den Test heisst das: jeder
 * Fall braucht eine FRISCHE Modulinstanz, sonst prueft der zweite Fall nur
 * noch die gemerkte Antwort des ersten. Der Anhaengsel-Parameter an der
 * Import-Adresse erzwingt genau das.
 *
 * (Dieselbe Falle hat auf `feat/dm-attachment-e2ee` schon einmal zugeschlagen
 * — dort sahen zwei Modulinstanzen im Testaufbau nur Startwerte, Commit
 * `65851748`.)
 */
async function frischesModul(marke: string) {
  return (await import(
    `../src/lib/identity/dauerhafterSpeicher.ts?fall=${marke}`
  )) as typeof import('../src/lib/identity/dauerhafterSpeicher.ts');
}

function setzeNavigator(storage: unknown): void {
  Object.defineProperty(globalThis, 'navigator', {
    value: storage === undefined ? {} : { storage },
    configurable: true,
    writable: true
  });
}

test('ohne die Browser-Schnittstelle heisst das Ergebnis "unbekannt"', async () => {
  setzeNavigator(undefined);
  const { dauerhaftenSpeicherAnfordern } = await frischesModul('ohne');
  assert.equal(await dauerhaftenSpeicherAnfordern(), 'unbekannt');
});

test('ist der Speicher schon dauerhaft, wird NICHT erneut gefragt', async () => {
  // Wichtig, weil Firefox bei `persist()` eine Nachfrage anzeigt: bei jedem
  // Start erneut zu fragen waere genau die Zumutung, die der Modulkopf
  // ausschliesst.
  let gefragt = 0;
  setzeNavigator({
    persisted: async () => true,
    persist: async () => {
      gefragt++;
      return true;
    }
  });
  const { dauerhaftenSpeicherAnfordern } = await frischesModul('schon');
  assert.equal(await dauerhaftenSpeicherAnfordern(), 'dauerhaft');
  assert.equal(gefragt, 0, 'persist() darf nicht gerufen worden sein');
});

test('gewaehrt der Browser gerade, heisst das Ergebnis "dauerhaft"', async () => {
  setzeNavigator({ persisted: async () => false, persist: async () => true });
  const { dauerhaftenSpeicherAnfordern } = await frischesModul('gewaehrt');
  assert.equal(await dauerhaftenSpeicherAnfordern(), 'dauerhaft');
});

test('lehnt der Browser ab, heisst das Ergebnis "abgelehnt" — und wirft nicht', async () => {
  setzeNavigator({ persisted: async () => false, persist: async () => false });
  const { dauerhaftenSpeicherAnfordern } = await frischesModul('nein');
  assert.equal(await dauerhaftenSpeicherAnfordern(), 'abgelehnt');
});

test('wirft die Umgebung statt abzulehnen, ist das dasselbe wie "gibt es nicht"', async () => {
  // Privates Fenster, gesperrter Speicher: manche Umgebungen werfen.
  setzeNavigator({
    persisted: async () => {
      throw new DOMException('SecurityError');
    },
    persist: async () => true
  });
  const { dauerhaftenSpeicherAnfordern } = await frischesModul('wirft');
  assert.equal(await dauerhaftenSpeicherAnfordern(), 'unbekannt');
});

test('es wird hoechstens EINMAL je Sitzung gefragt', async () => {
  let gefragt = 0;
  setzeNavigator({
    persisted: async () => false,
    persist: async () => {
      gefragt++;
      return true;
    }
  });
  const { dauerhaftenSpeicherAnfordern } = await frischesModul('einmal');
  await dauerhaftenSpeicherAnfordern();
  await dauerhaftenSpeicherAnfordern();
  await dauerhaftenSpeicherAnfordern();
  assert.equal(gefragt, 1, 'nach einem Nein wuerde sonst jeder Schreibvorgang erneut fragen');
});
