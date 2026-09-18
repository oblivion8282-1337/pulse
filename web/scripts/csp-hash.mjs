#!/usr/bin/env node
// CSP-Hash-Templating (Security-Scan 2026-09-18) — löst den bisherigen
// ponytail:-Aufstieg in infra/prod/security-headers.inc und der Self-Host-
// Caddyfile.template ein: 'unsafe-inline' in script-src raus, sha256-Hashes
// der Inline-Scripts rein.
//
// Liest das frisch gebaute index.html, berechnet für JEDES Inline-<script>
// (ohne src=) einen sha256-Hash (FOUC-Guard + SvelteKit-Bootstrap) und
// ersetzt in den übergebenen Header-Configs den Abschnitt
// `script-src 'self' 'unsafe-inline'` durch `script-src 'self' 'sha256-…' …`.
// CSP ignoriert 'unsafe-inline' komplett, sobald ein Hash daneben steht —
// der Ersatz ist also ein ERSETzen, kein ADDieren. style-src behält sein
// 'unsafe-inline' (Svelte-Styles sind pro Komponente dynamisch; der Needle
// nennt script-src explizit, style-src wird nie getroffen).
//
// Aufruf (in den Docker-Buildstufen web/Dockerfile + infra/self-host/Dockerfile):
//   node web/scripts/csp-hash.mjs <build/index.html> <config> [<config> …]
// Selbsttest: node web/scripts/csp-hash.mjs --self-test
//
// Exit 1, wenn kein Inline-Script gefunden (app.html/Template geändert) oder
// die Config den Needle nicht mehr enthält (Drift zwischen Build und
// Header-Konfiguration) — beides soll den Build brechen, nicht still
// 'unsafe-inline' ausliefern. Die Repo-Fassung der Configs behält
// 'unsafe-inline' als Fallback für Deployments ohne Templating-Schritt.

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

const NEEDLE = "script-src 'self' 'unsafe-inline'";
const SCRIPT_RE = /<script\b([^>]*)>([\s\S]*?)<\/script>/g;

export function inlineHashes(html) {
  const hashes = [];
  for (const m of html.matchAll(SCRIPT_RE)) {
    if (/\bsrc\s*=/i.test(m[1])) continue; // externe Scripte matchen via 'self'
    // Hash über den exakten Text zwischen > und </script> (script ist ein
    // raw-text-Element — keine Entity-Dekodierung, Dateibytes = Browser-Text).
    hashes.push(`'sha256-${createHash('sha256').update(m[2], 'utf8').digest('base64')}'`);
  }
  return hashes;
}

export function rewriteConfig(config, hashes) {
  if (!config.includes(NEEDLE)) {
    throw new Error(`Config enthält "${NEEDLE}" nicht mehr — script-src-Drift?`);
  }
  return config.replace(NEEDLE, `script-src 'self' ${hashes.join(' ')}`);
}

function assert(cond, msg) {
  if (!cond) {
    console.error(`[csp-hash] self-test FEHLER: ${msg}`);
    process.exit(1);
  }
}

function selfTest() {
  // Bekannter Vektor, unabhängig vom eigenen Codepfad: base64(sha256("hello")).
  const known = `'sha256-${createHash('sha256').update('hello', 'utf8').digest('base64')}'`;
  assert(
    known === "'sha256-LPJNul+wow4m6DsqxbninhsWHlwfp0JecwQzYpOLmCQ='",
    `sha256/base64-Encoding falsch: ${known}`,
  );

  const html = `<html><head><script>var a=1;</script></head><body>
    <script type="module" src="/_app/entry.js"></script>
    <script>var b=2;</script></body></html>`;
  const hashes = inlineHashes(html);
  assert(hashes.length === 2, `Inline-Zählung ${hashes.length} ≠ 2 (src=-Script muss ignoriert werden)`);

  const cfg =
    'add_header Content-Security-Policy "default-src \'self\'; ' +
    "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'; " +
    "style-src 'self' 'unsafe-inline'\"";
  const out = rewriteConfig(cfg, hashes);
  assert(!out.includes("script-src 'self' 'unsafe-inline'"), 'script-src-unsafe-inline nicht ersetzt');
  assert(out.includes("style-src 'self' 'unsafe-inline'"), 'style-src darf nicht angetastet werden');
  assert(out.includes(hashes[0]) && out.includes(hashes[1]), 'Hashes fehlen in der Ausgabe');
  console.log(`[csp-hash] self-test ok (${hashes.length} Hashes)`);
}

function main() {
  const args = process.argv.slice(2);
  if (args[0] === '--self-test') return selfTest();

  const [htmlPath, ...configPaths] = args;
  if (!htmlPath || configPaths.length === 0) {
    console.error('Nutzung: csp-hash.mjs <build/index.html> <config> [<config> …] | --self-test');
    process.exit(2);
  }
  const hashes = inlineHashes(readFileSync(htmlPath, 'utf8'));
  if (hashes.length === 0) {
    console.error(`[csp-hash] kein Inline-<script> in ${htmlPath} — Template geändert?`);
    process.exit(1);
  }
  for (const p of configPaths) {
    writeFileSync(p, rewriteConfig(readFileSync(p, 'utf8'), hashes));
    console.log(`[csp-hash] ${p}: 'unsafe-inline' → ${hashes.length} sha256-Hash(es)`);
  }
}

main();
