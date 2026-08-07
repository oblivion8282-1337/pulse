#!/usr/bin/env node
// PreToolUse-Hook: an graphify erinnern, bevor roh gesucht oder gelesen wird.
//
// **Warum das eine Datei ist und kein Einzeiler in `settings.json`.** Bis zum
// 2026-08-06 standen beide Hooks als `python3 -c "..."`-Einzeiler dort — mit
// dreifach verschachtelter Anfuehrungszeichen-Flucht, `chr(92)` fuer den
// Backslash und `2>/dev/null || true` am Ende. Zwei Folgen, beide schlecht:
//
// 1. **Auf dieser Windows-Maschine feuerten sie NIE.** `python3` ist hier der
//    Microsoft-Store-Platzhalter, der mit „Python was not found" abbricht; das
//    `|| true` verschluckte das, und der Hinweis blieb einfach aus. Ein Netz,
//    das man fuer gespannt haelt und das nicht da ist — genau die Sorte Fehler,
//    gegen die der Kasten oben in `README.md` steht.
// 2. Sie waren nicht pruefbar. Jetzt schon:
//    `echo '{"tool_input":{"command":"grep -r foo ."}}' | node .claude/hooks/graphify-hinweis.mjs bash`
//
// **Warum Node und nicht Python.** Node ist eine harte Voraussetzung dieses
// Repos auf JEDEM Rechner (pnpm-Workspace fuer `web` und `desktop`, >= 20).
// Python ist es nur fuer das Backend — dieser Windows-Rechner baut Sidecar und
// Player und hat berechtigterweise keins. Ein Hook, der auf einer Maschine
// still ausfaellt, ist schlechter als kein Hook, weil man sich auf ihn verlaesst.
//
// Aufruf: `node .claude/hooks/graphify-hinweis.mjs <bash|lesen>`
// Ausgabe: entweder nichts (dann greift der Hook nicht) oder eine Zeile JSON.
// **Beendet sich IMMER mit 0** — ein Hook darf einen Werkzeugaufruf nicht
// daran scheitern lassen, dass er selbst stolpert.

import { existsSync, readFileSync } from 'node:fs';

const modus = process.argv[2];

/** Die Aufforderung, die im jeweiligen Fall eingeblendet wird. */
const HINWEIS = {
  bash:
    'MANDATORY: graphify-out/graph.json exists. You MUST run `graphify query ' +
    '"<question>"` before grepping raw files. Only grep after graphify has ' +
    'oriented you, or to modify/debug specific lines.',
  lesen:
    'MANDATORY: graphify-out/graph.json exists. You MUST run graphify before ' +
    'reading source files. Use: `graphify query "<question>"` (scoped subgraph), ' +
    '`graphify explain "<concept>"`, or `graphify path "<A>" "<B>"`. Only read ' +
    'raw files after graphify has oriented you, or to modify/debug specific ' +
    'lines. This rule applies to subagents too — include it in every ' +
    'subagent prompt involving code exploration.',
};

/** Suchwerkzeuge, die der Bash-Hook abfaengt. */
const SUCHER = [/grep/, /(^|\s)rg\s/, /ripgrep/, /(^|\s)find\s/, /(^|\s)fd\s/, /(^|\s)ack\s/, /(^|\s)ag\s/];

/** Endungen, bei denen der Lese-Hook greift. */
const ENDUNGEN = [
  '.py', '.js', '.ts', '.tsx', '.jsx', '.go', '.rs', '.java', '.rb', '.c', '.h',
  '.cpp', '.hpp', '.cc', '.cs', '.kt', '.swift', '.php', '.scala', '.lua', '.sh',
  '.md', '.rst', '.txt', '.mdx',
];

function eingabe() {
  try {
    // `/dev/stdin` gibt es unter Windows nicht; Dateideskriptor 0 ueberall.
    return JSON.parse(readFileSync(0, 'utf8'));
  } catch {
    return null;
  }
}

function greift(daten) {
  const t = daten?.tool_input ?? daten ?? {};
  if (modus === 'bash') {
    const cmd = String(t.command ?? '');
    return SUCHER.some((r) => r.test(cmd));
  }
  // Lesen/Suchen ueber die Werkzeuge: Pfad UND Muster ansehen, denn `Glob`
  // traegt die Endung im Muster und `Read` im Pfad.
  const s = `${t.file_path ?? ''} ${t.pattern ?? ''} ${t.path ?? ''}`
    .toLowerCase()
    .replaceAll('\\', '/');
  // Die eigene Ausgabe ausnehmen — sonst verweist der Hinweis auf sich selbst.
  if (s.includes('graphify-out/')) return false;
  return ENDUNGEN.some((e) => s.includes(e));
}

try {
  // Ohne Graph gibt es nichts zu empfehlen. Zuerst gefragt, weil es der
  // haeufigste Grund ist, gar nichts zu tun.
  if (existsSync('graphify-out/graph.json') && HINWEIS[modus] && greift(eingabe())) {
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          additionalContext: HINWEIS[modus],
        },
      }) + '\n',
    );
  }
} catch {
  // Absichtlich stumm: s. Kopf.
}
