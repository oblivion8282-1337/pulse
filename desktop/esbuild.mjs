/**
 * Build the Electron main + preload bundles.
 *
 * Replaces the previous inline `esbuild ...` shell one-liner so the app
 * version can be injected via `define` without inlining the entire
 * `package.json` object into the bundle — and without a shell-specific
 * `$npm_package_version` expansion that would break under cmd.exe on Windows.
 */
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

await build({
  entryPoints: ['electron/main.ts', 'electron/preload.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  external: ['electron', 'electron-updater'],
  outdir: 'electron/dist',
  outExtension: { '.js': '.cjs' },
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  // Shrink the main-process bundle (less to parse on startup) but keep
  // identifiers intact so crash stack-traces stay readable.
  minifyWhitespace: true,
  minifySyntax: true,
  minifyIdentifiers: false
});
