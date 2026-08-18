// Selbstabgleich für den Remote-Dev-Start: sieht alle zehn Sekunden nach, ob
// auf dem eigenen Branch etwas Neues liegt, und zieht nach, wenn das gefahrlos
// ist. Der kurze Takt ist Absicht — es soll sich anfühlen, als bekäme der
// andere Rechner die Änderung sofort, ohne dass dort jemand etwas tippt.
//
// Der Takt ist billig, weil `git fetch` bei "nichts Neues" nur ein paar hundert
// Byte wechselt. Die Git-Aufrufe sind bewusst synchron: der Elternprozess
// beaufsichtigt nur Vite und Electron und hat sonst nichts zu tun, deshalb
// stört das kurze Blockieren niemanden — und der Code bleibt ohne
// Nebenläufigkeits-Gefummel lesbar. Aus demselben Grund kann sich auch nichts
// überlappen, wenn ein Abruf einmal länger dauert.
//
// KEIN CRON, KEIN DIENST. Das hier ist ein Zeitgeber im ohnehin laufenden
// `dev-remote.mjs`-Prozess. Er endet mit Strg+C und hinterlässt nichts auf der
// Maschine — wichtig, weil das auf mehreren Rechnern gleichzeitig läuft und
// niemand dort etwas einrichten oder später aufräumen soll.
//
// ── Warum die Bewachung nicht wegoptimiert werden darf ───────────────────────
// Ein blindes `git pull` wäre hier gefährlich: am 2026-08-18 lief auf einem
// zweiten Rechner PARALLEL eine Sitzung, die auf demselben Branch entwickelt
// hat. Automatisch nachziehen ist nur dann harmlos, wenn beides gilt:
//
//   1. der Arbeitsbaum ist sauber  → es gibt nichts zu überschreiben
//   2. es ist ein reiner Vorlauf   → es gibt nichts zusammenzuführen
//
// Trifft eines davon nicht zu, wird NUR gemeldet. Lieber ein Hinweis zu viel
// als eine zerlegte Arbeitskopie; `--ff-only` ist deshalb auch beim Nachziehen
// gesetzt und nicht bloß Vorsichtsschmuck.

import { execFileSync } from 'node:child_process';

const BACKEND_PFADE = ['services/', 'shared/', 'plugins/'];

/**
 * @param {object} o
 * @param {string} o.repo        Wurzel des Arbeitsverzeichnisses
 * @param {number} [o.intervallMs]
 * @param {(zeile: string) => void} [o.log]
 * @returns {() => void} beendet den Abgleich
 */
export function starteSelbstabgleich({ repo, intervallMs = 10_000, log = console.log }) {
  const git = (...args) =>
    execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();

  // Damit derselbe Hinweis nicht alle zwei Minuten erneut erscheint, wenn der
  // Zustand unverändert bleibt (dirty bleibt dirty, bis jemand etwas tut).
  let zuletztGemeldet = '';
  const melde = (schluessel, zeile) => {
    if (zuletztGemeldet === schluessel) return;
    zuletztGemeldet = schluessel;
    log(zeile);
  };

  function runde() {
    let branch;
    try {
      branch = git('rev-parse', '--abbrev-ref', 'HEAD');
      if (branch === 'HEAD') return; // losgelöster Kopf — nichts, wohin man zöge
      git('rev-parse', '--abbrev-ref', '@{u}'); // wirft ohne Gegenstück am Server
    } catch {
      return; // kein Upstream: lokaler Branch, den es entfernt nicht gibt
    }

    try {
      git('fetch', '--quiet');
    } catch {
      return; // kein Netz — beim nächsten Mal wieder
    }

    const [hinten, vorne] = git('rev-list', '--left-right', '--count', '@{u}...HEAD')
      .split(/\s+/)
      .map(Number);
    if (!hinten) {
      zuletztGemeldet = '';
      return;
    }

    const kopf = git('rev-parse', '--short', '@{u}');
    const schmutzig = git('status', '--porcelain') !== '';

    if (schmutzig) {
      melde(
        `dirty:${kopf}`,
        `  ⚠ ${hinten} neue Commit(s) auf ${branch}, aber der Arbeitsbaum ist nicht sauber — nicht gezogen. Selbst entscheiden: git stash / committen, dann git pull`
      );
      return;
    }
    if (vorne) {
      melde(
        `diverged:${kopf}`,
        `  ⚠ ${branch} ist ${hinten} zurück und ${vorne} voraus (auseinandergelaufen) — nicht gezogen. Selbst zusammenführen: git pull --rebase`
      );
      return;
    }

    const geaendert = git('diff', '--name-only', 'HEAD', '@{u}').split('\n').filter(Boolean);
    try {
      git('merge', '--ff-only', '@{u}');
    } catch {
      melde(`ffail:${kopf}`, `  ⚠ Vorlauf auf ${branch} schlug fehl — von Hand nachsehen`);
      return;
    }
    zuletztGemeldet = '';
    log(`  ✓ ${hinten} neue Commit(s) auf ${branch} geholt — die Oberfläche lädt per HMR selbst neu`);

    // Zwei Fälle, in denen "geholt" NICHT "wirksam" heißt — beide würden sonst
    // stillschweigend danebengehen und als Fehler an der falschen Stelle gesucht.
    if (geaendert.some((f) => BACKEND_PFADE.some((p) => f.startsWith(p)))) {
      log('  → Backend-Code dabei: der gemeinsame Stack bekommt ihn erst über  pnpm dev:sync');
    }
    if (geaendert.some((f) => f.startsWith('scripts/'))) {
      log('  → Werkzeuge geändert: wirkt erst nach einem Neustart von pnpm dev:remote');
    }
  }

  const timer = setInterval(() => {
    try {
      runde();
    } catch {
      // Ein Abgleich darf den Dev-Start nie mitreißen.
    }
  }, intervallMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
