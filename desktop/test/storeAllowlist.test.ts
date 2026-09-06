/**
 * Der Renderer speichert nur, was die Allowlist im Main-Prozess kennt.
 *
 * `store:set`/`store:setAll` verwerfen unbekannte Schlüssel **still** — eine
 * Zeile `console.warn` im Main-Log, sonst nichts. Der Renderer bekommt kein
 * Scheitern zurück, behält seinen Stand im Speicher und wirkt bis zum nächsten
 * Neuladen völlig richtig. Am 2026-08-16 hat das die Standplatz-Geräte gekostet:
 * `remote.geraete` stand nicht in der Liste, das eingetragene Gerät war nach
 * jedem Reload wieder „offline" und musste neu eingetragen werden — und die
 * Dauerfreigabe, das Protokoll und das Übertragungs-Profil desselben Geräts
 * teilten das Schicksal, ohne dass es jemandem auffiel.
 *
 * Deshalb dieser Test: er liest **Text**, keine Module. `main.ts` lässt sich
 * nicht importieren (es fährt beim Laden die Electron-App hoch), und der
 * Renderer-Code ist Svelte-TypeScript. Verglichen werden also die
 * Schlüssel-Literale beider Seiten — grob, aber es fällt genau dann um, wenn
 * jemand eine neue persistierte Einstellung einführt und die Allowlist vergisst.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const WURZEL = join(import.meta.dirname, '..', '..');

/** Die Allowlist aus `main.ts` — als Text gelesen, siehe oben. */
function erlaubteSchluessel(): Set<string> {
  const quelle = readFileSync(join(WURZEL, 'desktop', 'electron', 'main.ts'), 'utf8');
  const block = quelle.match(/const ALLOWED_STORE_KEYS = new Set\(\[([\s\S]*?)\n\]\);/);
  assert.ok(block, 'ALLOWED_STORE_KEYS in main.ts nicht gefunden — Test anpassen');
  return new Set([...block[1].matchAll(/^\s*'([^']+)',/gm)].map((m) => m[1]));
}

/**
 * Die Schlüssel, die der Renderer über `saveAll` schreibt.
 *
 * Zwei Quellen, weil es zwei Muster gibt: die Standplatz-Module halten je einen
 * `…_SCHLUESSEL`, die Stream-Einstellungen eine `PERSIST_KEYS`-Liste.
 *
 * **Beide Muster müssen wirklich gelesen werden, und breit.** Am 2026-08-18 traf
 * beides nicht zu, und derselbe Fehler kam deshalb doppelt durch: der Sammellauf
 * hörte auf den einen Namen `SPEICHER_SCHLUESSEL` statt auf die Sorte und
 * übersah einen zweiten Schlüssel in `devices/profil.svelte.ts`; und
 * `PERSIST_KEYS` stand zwar in dieser Doku, wurde aber nie gelesen — ein
 * Bereinigungs-Merker fehlte in der Allowlist, ohne dass es jemandem auffiel.
 * Solche Merker sagen „schon bereinigt"; verworfen laufen die einmaligen
 * Bereinigungen bei JEDEM Start erneut. Ein zu enges Muster sieht aus wie ein
 * bestandener Test.
 */
function geschriebeneSchluessel(): string[] {
  const lib = join(WURZEL, 'web', 'src', 'lib');
  const dateien: string[] = [];
  const sammeln = (verzeichnis: string): void => {
    for (const eintrag of readdirSync(verzeichnis, { withFileTypes: true })) {
      const pfad = join(verzeichnis, eintrag.name);
      if (eintrag.isDirectory()) sammeln(pfad);
      else if (eintrag.name.endsWith('.ts')) dateien.push(pfad);
    }
  };
  sammeln(lib);
  const gefunden = new Set<string>();
  for (const datei of dateien) {
    const text = readFileSync(datei, 'utf8');
    // Nur Dateien, die den Electron-Speicher WIRKLICH anfassen. Das Muster
    // oben hoert auf die Sorte (`…SCHLUESSEL`) und nicht auf einen Namen —
    // das ist Absicht und muss breit bleiben. Es trifft damit aber auch
    // Konstanten, die einen ganz anderen Speicher adressieren:
    // `krypto/account.svelte.ts` haelt `IDB_KEY_RUECKFALLSCHLUESSEL`, und der
    // geht ueber `idbGetIdentity`/`idbPutIdentity` in die IndexedDB, fuer die
    // `ALLOWED_STORE_KEYS` nicht zustaendig ist. Der Test meldete ihn am
    // 2026-08-28 als fehlend — ein Fehlalarm, und ein Fehlalarm ist hier
    // teuer: dieser Test soll das EINE Mal ueberzeugen, wenn er wirklich
    // umfaellt.
    //
    // Dass es am Namen lag und nicht an der Sache, zeigt der Nachbar drei
    // Zeilen darueber: `IDB_KEY = 'pulse.krypto-account'` liegt in derselben
    // IndexedDB und wurde nie gemeldet, weil sein Name nicht auf
    // `SCHLUESSEL` endet.
    //
    // Nachgesehen, nicht vermutet: alle vier echten Schreiber
    // (`devices/{anmeldung,profil}`, `remote/{protokoll,standplatz}`) nennen
    // `pulse.store` bzw. `persistence`, die Krypto-Datei nennt keines von
    // beiden. Fuehrt jemand einen fuenften Speicher-Schreiber ein, der den
    // Zugriff hinter einer weiteren Huelle versteckt, faellt er hier
    // stillschweigend heraus — dann gehoert diese Bedingung erweitert, nicht
    // das Schluessel-Muster.
    if (!/pulse\.store|persistence/.test(text)) continue;
    for (const treffer of text.matchAll(/[A-Z_]*SCHLUESSEL = '([^']+)'/g)) {
      gefunden.add(treffer[1]);
    }
    // Der Listen-Fall: `const PERSIST_KEYS = [ … ] as const;`. Genommen wird
    // nur, was allein auf seiner Zeile steht — die Liste ist durchkommentiert,
    // und in den Kommentaren stehen ebenfalls Literale in Anführungszeichen
    // (`capture_sources['1']`), die sonst als Schlüssel durchgingen.
    const liste = text.match(/const PERSIST_KEYS = \[([\s\S]*?)\n\]/);
    if (liste) {
      for (const treffer of liste[1].matchAll(/^\s*'([^']+)',\s*$/gm)) gefunden.add(treffer[1]);
    }
  }
  return [...gefunden];
}

test('jeder persistierte Renderer-Schlüssel steht in der Main-Allowlist', () => {
  const erlaubt = erlaubteSchluessel();
  const fehlend = geschriebeneSchluessel().filter((k) => !erlaubt.has(k));
  assert.deepEqual(
    fehlend,
    [],
    `Diese Schlüssel schreibt der Renderer, aber der Main-Prozess verwirft sie: ${fehlend.join(', ')}`,
  );
});

test('die Standplatz-Schlüssel sind namentlich dabei', () => {
  // Namentlich und nicht nur über den Sammellauf oben: verschwindet einer der
  // Speicher (umbenannt, zusammengelegt), soll dieser Test darauf zeigen und
  // nicht stillschweigend grün bleiben, weil er nichts mehr zu vergleichen hat.
  const erlaubt = erlaubteSchluessel();
  for (const k of [
    'remote.geraete',
    'remote.standplatz',
    'remote.protokoll',
    'remote.standplatzProfil',
  ]) {
    assert.ok(erlaubt.has(k), `${k} fehlt in ALLOWED_STORE_KEYS`);
  }
});
