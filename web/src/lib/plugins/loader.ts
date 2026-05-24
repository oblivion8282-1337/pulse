/**
 * Frontend plugin loader — discovery + activation of every plugin we find
 * in the repo-root `plugins/` directory.
 *
 * The browser can't walk the filesystem, so discovery is a *build-time*
 * affair: Vite's `import.meta.glob` enumerates every `plugins/<name>/manifest.ts`
 * + every `plugins/<name>/frontend.ts`, and the loader binds them together
 * at runtime.
 *
 * Why a hand-written `manifest.ts` instead of parsing `plugin.toml`?
 * 1. No TOML parser ships in the browser bundle.
 * 2. The frontend manifest doubles as a typing anchor — pulling it from a
 *    `.ts` file means the structure is checked by `svelte-check`.
 * 3. The repo's `plugin.toml` stays the source of truth for the backend
 *    loader; the matching `manifest.ts` is a thin mirror checked into
 *    each plugin directory.
 *
 * Failure mode: per-plugin errors are logged + skipped. The loader never
 * throws — a bad plugin must not gate the app's boot path.
 */
import { activatePlugin, addPlugin, deactivatePlugin } from './registry';
import {
  isPluginActivated,
  markPluginActivated,
  markPluginDeactivated
} from './activation-state.svelte';
import type { PluginEntryModule, PluginManifest } from './manifest-types';

// Vite glob — eager so the manifests are part of the initial bundle. Each
// plugin must export its manifest as the default export of `manifest.ts`.
// The glob path is relative to *this* file; ascending up to repo-root and
// back down into `plugins/`. SvelteKit's `$lib` alias keeps this stable.
const manifestModules = import.meta.glob<{ default: PluginManifest }>(
  '/../plugins/*/manifest.ts',
  { eager: true }
);

// Lazy glob — the actual register/deactivate code stays in its own chunk
// so an inactive plugin's bundle is fetched on demand. `eager: false` is
// the Vite default but we make it explicit for readability.
const entryModules = import.meta.glob<PluginEntryModule>('/../plugins/*/frontend.ts');

function nameFromPath(path: string): string | null {
  // Glob paths look like '/../plugins/hello/manifest.ts'. Extract the
  // segment between 'plugins/' and the next slash.
  const m = path.match(/\/plugins\/([^/]+)\//);
  return m ? m[1] : null;
}

interface DiscoveredPlugin {
  manifest: PluginManifest;
  entryPath: string | null;
}

/** Build the {name → manifest + entry-path} map without registering anything.
 *  Exported so a future plugin-manager UI can browse without auto-activating. */
export function discoverPlugins(): Map<string, DiscoveredPlugin> {
  const out = new Map<string, DiscoveredPlugin>();
  for (const [path, mod] of Object.entries(manifestModules)) {
    const dirName = nameFromPath(path);
    if (!dirName) continue;
    const manifest = mod.default;
    if (manifest.name !== dirName) {
      console.error(
        `[plugins] ${path}: manifest name ${JSON.stringify(manifest.name)} does not match directory`
      );
      continue;
    }
    const entryPath =
      Object.keys(entryModules).find((p) => nameFromPath(p) === dirName) ?? null;
    out.set(dirName, { manifest, entryPath });
  }
  return out;
}

/** Discover every plugin, register them with the runtime registry, and
 *  activate the ones marked active in the persisted Plugin-Settings-Section
 *  (Schritt 6). Backend-only plugins are registered with the manifest but
 *  not activated on the frontend. Inaktive Plugins erscheinen weiter im
 *  Plugin-Manager-UI (das nutzt `listPlugins()`); ihr `frontend.ts` wird
 *  erst beim Toggle dynamisch importiert.
 *
 *  Returns the list of names that activated successfully. */
export async function loadAll(): Promise<string[]> {
  const discovered = discoverPlugins();
  const activated: string[] = [];
  for (const [name, info] of discovered) {
    if (!info.entryPath) {
      // Backend-only — manifest tracked, no frontend register-call.
      try {
        addPlugin({ manifest: info.manifest, entry: noFrontendEntry(name) });
      } catch (err) {
        console.error(`[plugins] ${name}: add failed`, err);
      }
      continue;
    }
    const entryLoader = entryModules[info.entryPath];
    if (!entryLoader) {
      console.error(`[plugins] ${name}: no entry loader for ${info.entryPath}`);
      continue;
    }
    try {
      addPlugin({ manifest: info.manifest, entry: entryLoader });
    } catch (err) {
      console.error(`[plugins] ${name}: add failed`, err);
      continue;
    }
    if (!isPluginActivated(name)) {
      // Persistierter State sagt: bleibt aus. Nur als Record vorhanden,
      // damit das Plugin-Manager-UI es anzeigen und togglen kann.
      continue;
    }
    try {
      await activatePlugin(name);
      activated.push(name);
    } catch (err) {
      console.error(`[plugins] ${name}: activate failed`, err);
    }
  }
  // Self-Heal: falls discoverte Plugins existieren, die noch nicht in der
  // Activation-Liste sind und gleichzeitig der Bootstrap-Default-Liste
  // (z.B. `hello`) angehören, sind sie via `isPluginActivated` schon
  // berücksichtigt — siehe `activation-state.svelte.ts`. Nichts zu tun.
  if (activated.length > 0) {
    console.info(`[plugins] activated: ${activated.join(', ')}`);
  }
  return activated;
}

/** Toggle ein Plugin und persistiert den Activation-State. Wird vom
 *  Plugin-Manager-UI aufgerufen. Wirft die Fehler der activate/deactivate-
 *  Pfade weiter, sodass das UI sie als Toast anzeigen kann.
 *
 *  Persistiere den State erst NACH dem erfolgreichen Activate/Deactivate —
 *  sonst hätten wir bei einer Exception einen inkonsistenten Persist-Stand
 *  (UI denkt "aktiv", Registry sagt "tot"). */
export async function setPluginActivated(name: string, active: boolean): Promise<void> {
  if (active) {
    await activatePlugin(name);
    markPluginActivated(name);
  } else {
    await deactivatePlugin(name);
    markPluginDeactivated(name);
  }
}

function noFrontendEntry(name: string): () => Promise<PluginEntryModule> {
  return () => {
    throw new Error(`plugin ${name}: has no frontend entry to activate`);
  };
}
