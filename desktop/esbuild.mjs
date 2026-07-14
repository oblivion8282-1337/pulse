/**
 * Build the Electron main + preload bundles.
 *
 * Replaces the previous inline `esbuild ...` shell one-liner so the app
 * version can be injected via `define` without inlining the entire
 * `package.json` object into the bundle — and without a shell-specific
 * `$npm_package_version` expansion that would break under cmd.exe on Windows.
 */
import { build } from 'esbuild';
import { readFileSync, copyFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

// Server-Build-Modus: entweder per `--server`-Flag (cross-shell — cmd.exe, pwsh
// und bash lesen argv gleichermaßen) ODER per `PULSE_BUILD_MODE=server`-Env
// (POSIX-Shells / Flatpak-Manifest). Das Flag ist der Windows-taugliche Weg:
// ein `VAR=val cmd`-Prefix ist unter cmd.exe KEIN gültiges Env-Setzen, weshalb
// `dist:win:server` das Flag nutzt.
const serverMode = process.argv.includes('--server') || process.env.PULSE_BUILD_MODE === 'server';

await build({
  entryPoints: ['electron/main.ts', 'electron/preload.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  external: ['electron', 'electron-updater'],
  outdir: 'electron/dist',
  outExtension: { '.js': '.cjs' },
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    // Build-Mode: 'client' (Default, lädt howispulse.com) oder 'server'
    // (Pulse Server-App — lädt lokales server.html, HostLifecycle im Lochungs-Modus).
    __APP_MODE__: JSON.stringify(serverMode ? 'server' : 'client'),
  },
  // Shrink the main-process bundle (less to parse on startup) but keep
  // identifiers intact so crash stack-traces stay readable.
  minifyWhitespace: true,
  minifySyntax: true,
  minifyIdentifiers: false
});

// Server-App: die statische server.html/server.js müssen neben main.cjs liegen,
// damit `loadFile(__dirname/server.html)` im gepackten Build greift. Der Kopier-
// schritt lebt hier (nicht als `cp` im npm-Script), weil `cp` unter Windows-
// cmd.exe fehlt — Node-fs ist plattformneutral.
if (serverMode) {
  for (const f of ['server.html', 'server.js']) {
    copyFileSync(new URL(`./electron/${f}`, import.meta.url), new URL(`./electron/dist/${f}`, import.meta.url));
  }
}
