import { test } from 'node:test';
import assert from 'node:assert/strict';

/**
 * Bughunt 2026-08-29: der Krypto-Zustand liegt in IndexedDB (geteilt ueber
 * ALLE Tabs eines Browserprofils), die Absicherung lag aber in einer
 * Modul-`Map` (je Tab neu). Diese Datei prueft beides — dass die Sperre
 * ueberhaupt tab-uebergreifend greift, und dass sie an den drei Abläufen im
 * richtigen ZUSCHNITT sitzt (Laden, Aendern und Sichern zusammen).
 *
 * **Zwei Modul-Instanzen = zwei Tabs.** `import('…?tab=b')` ist fuer Nodes
 * Lader ein anderer Modulschluessel; die Datei laeuft ein zweites Mal, mit
 * eigenem Modul-Scope. Genau das trennt einen zweiten Tab vom ersten — nicht
 * mehr und nicht weniger. Gegen die alte Fassung (`sitzungssperre.ts`, eine
 * `Map` im Modul-Scope) war dieser Aufbau rot: `maxGleichzeitig` 2 statt 1.
 *
 * **Was hier NICHT bewiesen wird:** dass echte Web Locks tab-uebergreifend
 * gelten. Nodes Testlaeufer hat kein `navigator.locks`; die Nachbildung unten
 * steht stellvertretend fuer den Browser-Verwalter und wird von BEIDEN
 * Instanzen ueber `globalThis` gefunden — der Beweis, dass `sperren.ts` an
 * einen GETEILTEN Verwalter delegiert statt an einen eigenen. Dass dieser
 * Verwalter je Herkunft (nicht je Tab) existiert, garantiert die
 * Web-Locks-Spezifikation; nachgesehen wird es im Browser, s.
 * `tests/e2e/krypto-sperren-tabs.spec.ts`.
 */

/** Nachbildung von `navigator.locks` fuer `mode: 'exclusive'`: je Name eine
 *  Kette, die naechste Aufgabe startet erst, wenn die vorherige sich
 *  entschieden hat — auch bei einem Fehler (wie im Browser). */
function lockVerwalterAnlegen() {
  const ketten = new Map<string, Promise<unknown>>();
  return {
    request<T>(name: string, _optionen: { mode: 'exclusive' }, aufgabe: () => Promise<T>) {
      const vorherige = ketten.get(name) ?? Promise.resolve();
      const eigene = vorherige.then(aufgabe, aufgabe);
      ketten.set(
        name,
        eigene.catch(() => undefined)
      );
      return eigene;
    }
  };
}

function navigatorStellen(wert: unknown): void {
  Object.defineProperty(globalThis, 'navigator', {
    value: wert,
    configurable: true,
    writable: true
  });
}

navigatorStellen({ locks: lockVerwalterAnlegen() });

/** Der Pfad steht als Variable da, damit TypeScript den Anhang `?tab=…` nicht
 *  aufzuloesen versucht — fuer den Typpruefer ist das ein anderes Modul, fuer
 *  Nodes Lader genau der gewuenschte zweite Modulschluessel. Die Typen kommen
 *  ueber einen reinen Typ-Import, der zur Laufzeit keine dritte Instanz
 *  anlegt. */
type SperrenModul = typeof import('../src/lib/krypto/sperren.ts');
const modulPfad = '../src/lib/krypto/sperren.ts';
const tabA = (await import(`${modulPfad}?tab=a`)) as SperrenModul;
const tabB = (await import(`${modulPfad}?tab=b`)) as SperrenModul;

function warte(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Die Sperre selbst
// ---------------------------------------------------------------------------

test('zwei Tabs laufen nie gleichzeitig in derselben Sitzung', async () => {
  let gleichzeitig = 0;
  let maxGleichzeitig = 0;
  async function aufgabe(dauerMs: number): Promise<void> {
    gleichzeitig += 1;
    maxGleichzeitig = Math.max(maxGleichzeitig, gleichzeitig);
    await warte(dauerMs);
    gleichzeitig -= 1;
  }

  await Promise.all([
    tabA.mitSchluesselsperre('kanal:geraet', () => aufgabe(20)),
    tabB.mitSchluesselsperre('kanal:geraet', () => aufgabe(20))
  ]);

  assert.equal(maxGleichzeitig, 1);
});

test('zwei Tabs laufen nie gleichzeitig auf demselben Konto', async () => {
  let gleichzeitig = 0;
  let maxGleichzeitig = 0;
  async function aufgabe(): Promise<void> {
    gleichzeitig += 1;
    maxGleichzeitig = Math.max(maxGleichzeitig, gleichzeitig);
    await warte(15);
    gleichzeitig -= 1;
  }
  await Promise.all([tabA.mitKontosperre(aufgabe), tabB.mitKontosperre(aufgabe)]);
  assert.equal(maxGleichzeitig, 1);
});

test('zwei Tabs laufen nie gleichzeitig in derselben Gruppensitzung', async () => {
  let gleichzeitig = 0;
  let maxGleichzeitig = 0;
  async function aufgabe(): Promise<void> {
    gleichzeitig += 1;
    maxGleichzeitig = Math.max(maxGleichzeitig, gleichzeitig);
    await warte(15);
    gleichzeitig -= 1;
  }
  await Promise.all([
    tabA.mitGruppensitzungssperre('kanal-1', aufgabe),
    tabB.mitGruppensitzungssperre('kanal-1', aufgabe)
  ]);
  assert.equal(maxGleichzeitig, 1);
});

test('unabhaengige Gespraeche blockieren einander nicht', async () => {
  const reihenfolge: string[] = [];
  // 'langsam' startet zuerst, dauert aber laenger — nur bei echter
  // Unabhaengigkeit beendet 'schnell' vorher. Drei Paare, die sich NICHT
  // teilen duerfen: zwei Gespraeche, zwei Gruppen, Konto gegen Sitzung.
  await Promise.all([
    tabA.mitSchluesselsperre('kanal-1:geraet', async () => {
      await warte(30);
      reihenfolge.push('langsam');
    }),
    tabB.mitSchluesselsperre('kanal-2:geraet', async () => {
      await warte(5);
      reihenfolge.push('schnell-anderes-gespraech');
    }),
    tabB.mitGruppensitzungssperre('kanal-2', async () => {
      await warte(5);
      reihenfolge.push('schnell-gruppe');
    }),
    tabB.mitKontosperre(async () => {
      await warte(5);
      reihenfolge.push('schnell-konto');
    })
  ]);
  assert.equal(reihenfolge.at(-1), 'langsam');
  assert.equal(reihenfolge.length, 4);
});

test('Konto und Gruppensitzung teilen sich keinen Namen mit einer Sitzung', () => {
  const namen = new Set([
    tabA.KONTO_SPERRE,
    tabA.sitzungsSperrname('kanal-1:geraet'),
    tabA.gruppensitzungsSperrname('kanal-1')
  ]);
  assert.equal(namen.size, 3);
});

test('ein Fehlschlag gibt die Sperre frei und wird weitergereicht', async () => {
  // Sonst legte ein einziger Fehler den Klienten still lahm — die naechste
  // Aufgabe fuer denselben Namen kaeme nie mehr dran.
  const erste = tabA.mitSchluesselsperre('kanal:geraet-y', async () => {
    throw new Error('kaputt');
  });
  const zweite = tabB.mitSchluesselsperre('kanal:geraet-y', async () => 'erfolgreich');

  await assert.rejects(erste, /kaputt/);
  assert.equal(await zweite, 'erfolgreich');
});

test('ohne navigator.locks wird geworfen statt still ungesichert zu laufen', async () => {
  const echt = globalThis.navigator;
  navigatorStellen(undefined);
  try {
    let gelaufen = false;
    await assert.rejects(
      tabA.mitKontosperre(async () => {
        gelaufen = true;
      }),
      (err: unknown) => err instanceof tabA.SperrenNichtVerfuegbar
    );
    // Der eigentliche Punkt: die Aufgabe darf NICHT trotzdem gelaufen sein.
    assert.equal(gelaufen, false);
  } finally {
    navigatorStellen(echt);
  }
});

// ---------------------------------------------------------------------------
// Der Zuschnitt an den Abläufen — Nachbildungen, keine echten Aufrufe
// ---------------------------------------------------------------------------
//
// Die echten Abläufe haengen an WASM und IndexedDB und sind hier nicht
// ladbar. Nachgebildet ist deshalb die REIHENFOLGE der Schritte, so wie sie
// im Quelltext steht — inklusive der Netzaufrufe dazwischen, denn genau die
// Frage „gehoert das Netz mit unter die Sperre?" entscheidet den Ausgang.
// Beide Nachbildungen laufen ZWEIMAL: einmal ohne Sperre (der Schaden tritt
// ein — das ist die Gegenprobe) und einmal mit (er tritt nicht ein).

type Sperre = <T>(aufgabe: () => Promise<T>) => Promise<T>;
const OHNE_SPERRE: Sperre = (aufgabe) => aufgabe();

/** Nachbildung von `veroeffentlichen.ts::veroeffentlicheSchluessel`. */
async function schluesselVeroeffentlichen(
  sperre: Sperre,
  marke: string,
  netzDauerMs: number,
  welt: { speicher: { erzeugt: string[]; veroeffentlicht: string[] }; server: Set<string> }
): Promise<void> {
  await sperre(async () => {
    // Laden.
    const konto = {
      erzeugt: [...welt.speicher.erzeugt],
      veroeffentlicht: new Set(welt.speicher.veroeffentlicht)
    };
    // Netz: `keysApi.oneTimeKeyCount`.
    await warte(1);
    if (welt.server.size < 20) {
      for (let i = 0; i < 30; i += 1) konto.erzeugt.push(`${marke}-${i}`);
      // Sichern, wie `kryptoAccountSichern` nach `einmalschluesselErzeugen`.
      welt.speicher = { erzeugt: [...konto.erzeugt], veroeffentlicht: [...konto.veroeffentlicht] };
    }
    const offen = konto.erzeugt.filter((s) => !konto.veroeffentlicht.has(s));
    if (offen.length === 0) return;
    // Netz: `keysApi.addOneTimeKeys` — die oeffentlichen Haelften gehen raus.
    await warte(netzDauerMs);
    for (const s of offen) welt.server.add(s);
    // `alsVeroeffentlichtMarkieren` + sichern.
    for (const s of offen) konto.veroeffentlicht.add(s);
    welt.speicher = { erzeugt: [...konto.erzeugt], veroeffentlicht: [...konto.veroeffentlicht] };
  });
}

/** Wie viele oeffentliche Haelften auf dem Server KEINE private Haelfte mehr
 *  im Speicher haben — jede davon macht die naechste Nachricht, die sie
 *  beansprucht, dauerhaft unlesbar. */
async function verwaisteSchluessel(sperre: Sperre): Promise<number> {
  const welt = {
    speicher: { erzeugt: [] as string[], veroeffentlicht: [] as string[] },
    server: new Set<string>()
  };
  await Promise.all([
    schluesselVeroeffentlichen(sperre, 'a', 40, welt),
    (async () => {
      await warte(5);
      await schluesselVeroeffentlichen(sperre, 'b', 0, welt);
    })()
  ]);
  const privat = new Set(welt.speicher.erzeugt);
  return [...welt.server].filter((s) => !privat.has(s)).length;
}

test('GEGENPROBE Konto: ohne Sperre verlieren zwei Tabs private Schluesselhaelften', async () => {
  assert.ok(
    (await verwaisteSchluessel(OHNE_SPERRE)) > 0,
    'Die Nachbildung bildet den Schaden nicht mehr ab — dann beweist der Test darunter nichts.'
  );
});

test('mit Konto-Sperre bleibt zu jeder oeffentlichen Haelfte die private', async () => {
  assert.equal(await verwaisteSchluessel(tabA.mitKontosperre), 0);
});

/** Nachbildung von `gruppe/senden.ts`, Schritt 3 bis 6: laden, (Netz),
 *  verschluesseln, sichern. `verschluesseln` verbraucht den Ratchet-Platz. */
async function inGruppeSenden(
  sperre: Sperre,
  netzDauerMs: number,
  welt: { zaehler: number; benutzt: number[] }
): Promise<void> {
  await sperre(async () => {
    const stand = welt.zaehler; // gruppensitzungLaden
    await warte(netzDauerMs); // keysApi.claim + verteilUmschlaege
    welt.benutzt.push(stand); // sitzung.verschluesseln
    welt.zaehler = stand + 1; // gruppensitzungSichern
  });
}

/** Wie oft derselbe Ratchet-Platz zweimal benutzt wurde. */
async function doppelteRatchetPlaetze(sperre: Sperre): Promise<number> {
  const welt = { zaehler: 0, benutzt: [] as number[] };
  await Promise.all([
    inGruppeSenden(sperre, 30, welt),
    (async () => {
      await warte(5);
      await inGruppeSenden(sperre, 0, welt);
    })()
  ]);
  return welt.benutzt.length - new Set(welt.benutzt).size;
}

test('GEGENPROBE Gruppe: ohne Sperre verschluesseln zwei Sendungen am selben Platz', async () => {
  assert.ok(
    (await doppelteRatchetPlaetze(OHNE_SPERRE)) > 0,
    'Die Nachbildung bildet den Schaden nicht mehr ab — dann beweist der Test darunter nichts.'
  );
});

test('mit Gruppen-Sperre bekommt jede Sendung ihren eigenen Ratchet-Platz', async () => {
  const mitSperre: Sperre = (aufgabe) => tabA.mitGruppensitzungssperre('kanal-g', aufgabe);
  assert.equal(await doppelteRatchetPlaetze(mitSperre), 0);
});
