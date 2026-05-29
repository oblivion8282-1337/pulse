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
 *
 * Activation-Modell (seit Plugin-Admin-Aktivierungs-PR)
 * -----------------------------------------------------
 * Es gibt **keinen per-User-Activation-State mehr**. Der Frontend-Loader
 * registriert beim Boot jedes entdeckte Plugin in der Runtime-Registry
 * (Handler/Sections binden sich an). UI-Rendering pro Guild prüft danach
 * den `guild-activation.svelte.ts`-Store (Server-State, MANAGE_GUILD-
 * Admin-gepflegt). Plugin-Ops, die ohne Guild-Aktivierung gesendet
 * werden, blockt der Backend-Op-Gate (4040–4043).
 *
 * Backend-only-Plugins (kein `frontend.ts`) werden mit einem No-Op-Entry
 * registriert, damit `listPlugins()` sie für eventuelle UI-Inspektion
 * (z.B. Admin-Panel) listen kann.
 */
import { activatePlugin, addPlugin } from './registry';
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
  // Build a name-to-entry-path map once, O(m), instead of O(n×m) inner finds.
  const entryPathsByName = new Map<string, string>();
  for (const path of Object.keys(entryModules)) {
    const dirName = nameFromPath(path);
    if (dirName) {
      entryPathsByName.set(dirName, path);
    }
  }
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
    const entryPath = entryPathsByName.get(dirName) ?? null;
    out.set(dirName, { manifest, entryPath });
  }
  return out;
}

/** Discover every plugin, register it in the runtime registry, and
 *  activate its frontend entry. Pro-Guild-Sichtbarkeit der UI-Slots
 *  läuft NICHT mehr über diesen Loader — sie wird vom `guild-activation`-
 *  Store entschieden. Der Loader sorgt nur dafür, dass Plugin-Handler/
 *  Sections bei laufender App verfügbar sind, sobald sie benötigt werden.
 *
 *  Backend-only Plugins (kein `frontend.ts`) werden registriert, aber
 *  nicht aktiviert (kein Entry zu laden).
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
    try {
      await activatePlugin(name);
      activated.push(name);
    } catch (err) {
      console.error(`[plugins] ${name}: activate failed`, err);
    }
  }
  if (activated.length > 0) {
    console.info(`[plugins] activated: ${activated.join(', ')}`);
  }
  return activated;
}

function noFrontendEntry(name: string): () => Promise<PluginEntryModule> {
  return () => {
    throw new Error(`plugin ${name}: has no frontend entry to activate`);
  };
}
