/**
 * Settings section registry — runtime plugin-point for adding new settings
 * sections without mutating the static `PersistedSettings` shape.
 *
 * Symmetric to the WS handler-registry (`lib/ws/handler-registry.ts`) and the
 * backend's `@register_ws_op` decorator (Phase 2 of the Plugin-System-Plan).
 * A plugin registers a section by name, supplying defaults + an optional
 * parser/clamper + a sign-out policy; reads go through `getSection(name)`,
 * which returns a thin reactive wrapper backed by a Svelte 5 rune.
 *
 * Persistence shape stays in the existing `dcc.settings` localStorage blob
 * — one top-level key per section, plus a `_meta` object for per-section
 * version numbers. The registry takes ownership of load/save; the public
 * `SettingsStore` facade re-exposes each section as a typed property for
 * the existing component imports (`settings.audio.bitrate` etc.).
 */
import type { PersistenceMode, SectionConfig, SectionStore, SignOutPolicy } from './types';
import {
  fetchAllPreferences,
  flushAllPending,
  schedulePushSection
} from './server-sync';

const STORAGE_KEY = 'dcc.settings';
/** Persist debounce window. The pre-registry code persisted synchronously
 *  per setter call (no batching), so we keep this at 0 for behaviour
 *  neutrality. Plugins doing hot-loop writes can rebind persistence (or
 *  call `flushPersist`) if they need batching. */
const PERSIST_DEBOUNCE_MS = 0;

type AnyConfig = SectionConfig<unknown>;

interface RegisteredSection {
  config: AnyConfig;
  store: SectionStore<unknown>;
}

const sections = new Map<string, RegisteredSection>();
let storageHandle: PersistenceHandle | null = null;
let pendingTimer: ReturnType<typeof setTimeout> | null = null;

interface PersistenceHandle {
  read(): Record<string, unknown>;
  write(blob: Record<string, unknown>): void;
}

/** Bootstrap the registry against localStorage (or an in-memory shim for
 *  SSR/tests). Called once from `lib/stores/settings.svelte.ts` before any
 *  section registers; idempotent. */
export function bindPersistence(handle: PersistenceHandle): void {
  storageHandle = handle;
}

function defaultHandle(): PersistenceHandle {
  return {
    read() {
      if (typeof localStorage === 'undefined') return {};
      try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return {};
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
      } catch {
        return {};
      }
    },
    write(blob) {
      if (typeof localStorage === 'undefined') return;
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(blob));
      } catch {
        /* ignore quota errors */
      }
    }
  };
}

function getHandle(): PersistenceHandle {
  if (!storageHandle) storageHandle = defaultHandle();
  return storageHandle;
}

/** Read the persisted root blob; sections grab their own slice from it. */
function readRoot(): Record<string, unknown> {
  return getHandle().read();
}

/** Resolve the effective persistence mode for a section. Default
 *  ``'local'`` keeps every pre-Schritt-3b section unchanged. */
function modeOf(config: AnyConfig): PersistenceMode {
  return config.persistence ?? 'local';
}

function writesLocal(mode: PersistenceMode): boolean {
  return mode === 'local' || mode === 'both';
}

function writesServer(mode: PersistenceMode): boolean {
  return mode === 'server' || mode === 'both';
}

/** Snapshot all registered sections into a single blob + write it. Sections
 *  that registered before bindPersistence ran would be lost; that's why
 *  bindPersistence must be called first in the boot path.
 *
 *  Server-only sections (``persistence: 'server'``) are excluded from
 *  the localStorage blob — they live exclusively in
 *  ``user_preferences``. ``'both'`` mode still writes locally (it's
 *  the offline-resilience opt-in). */
function persistAll(): void {
  const blob: Record<string, unknown> = {};
  const meta: Record<string, number> = {};
  for (const [name, reg] of sections.entries()) {
    if (!writesLocal(modeOf(reg.config))) continue;
    blob[name] = reg.store.snapshot();
    if (reg.config.version !== undefined) meta[`${name}_version`] = reg.config.version;
  }
  if (Object.keys(meta).length > 0) blob._meta = meta;
  getHandle().write(blob);
}

/** Schedule a persist. Called by every section setter. When the debounce
 *  window is 0 (current default) we persist synchronously — matches the
 *  pre-registry behaviour where every setter wrote localStorage immediately.
 *  When non-zero, set-storms during slider drags collapse into one write. */
export function schedulePersist(): void {
  if (PERSIST_DEBOUNCE_MS === 0) {
    persistAll();
    return;
  }
  if (pendingTimer !== null) clearTimeout(pendingTimer);
  pendingTimer = setTimeout(() => {
    pendingTimer = null;
    persistAll();
  }, PERSIST_DEBOUNCE_MS);
}

/** Force an immediate flush — used on sign-out (where the route change races
 *  the debounce window) and when the registry is asked to migrate legacy data. */
export function flushPersist(): void {
  if (pendingTimer !== null) {
    clearTimeout(pendingTimer);
    pendingTimer = null;
  }
  persistAll();
}

/**
 * Register a section. Returns a reactive store wrapping a Svelte 5 rune so
 * components can read `store.value.someKey` (rune-tracked) or use the
 * convenience accessors `get/set/patch/reset`.
 *
 * Re-registering an already-registered name is a no-op that returns the
 * existing store — matches the "last-registration wins, plugins can rebind"
 * semantics of the WS-handler registry but for stateful sections we prefer
 * the safer "first registration sticks" so plugins don't accidentally wipe
 * user data by registering twice.
 */
export function registerSettingsSection<T>(
  name: string,
  config: SectionConfig<T>
): SectionStore<T> {
  const existing = sections.get(name);
  if (existing) return existing.store as SectionStore<T>;

  const root = readRoot();
  const meta = (root._meta ?? {}) as Record<string, unknown>;
  const storedVersion =
    typeof meta[`${name}_version`] === 'number' ? (meta[`${name}_version`] as number) : 0;
  const wantedVersion = config.version ?? 0;

  let initial: T;
  const slice = root[name];
  if (slice === undefined) {
    initial = cloneDefaults(config.defaults);
  } else if (storedVersion !== wantedVersion && config.migrate) {
    initial = config.migrate(slice, storedVersion);
  } else if (config.parse) {
    initial = config.parse(slice);
  } else {
    initial = mergeShallow(config.defaults, slice as Partial<T>);
  }

  const store = makeSectionStore(name, config, initial);
  sections.set(name, { config: config as AnyConfig, store: store as SectionStore<unknown> });
  return store;
}

function cloneDefaults<T>(d: T): T {
  if (d === null || typeof d !== 'object') return d;
  return JSON.parse(JSON.stringify(d)) as T;
}

function mergeShallow<T>(defaults: T, partial: Partial<T> | undefined): T {
  if (!partial || typeof partial !== 'object') return cloneDefaults(defaults);
  return { ...cloneDefaults(defaults), ...partial };
}

/** Build the reactive wrapper for one section. Internal — not exported. */
function makeSectionStore<T>(
  name: string,
  config: SectionConfig<T>,
  initial: T
): SectionStore<T> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let _value: T = $state(initial) as any;
  const mode = modeOf(config as AnyConfig);

  function snapshot(): T {
    // JSON-roundtrip strips the `$state` proxy so the persisted blob is
    // a plain object — JSON.stringify on a runed proxy works but `===`
    // identity in tests gets confusing if we leak the proxy.
    return JSON.parse(JSON.stringify(_value)) as T;
  }

  /** Persist after every mutation. ``schedulePersist`` writes the local
   *  blob (no-op for server-only sections); ``schedulePushSection``
   *  fires the debounced server PUT for server / both modes. */
  function onMutate(): void {
    schedulePersist();
    if (writesServer(mode)) schedulePushSection(name, snapshot);
  }

  const store: SectionStore<T> = {
    name,
    get value() {
      return _value;
    },
    get(key) {
      return _value[key];
    },
    set(key, val) {
      _value[key] = val;
      onMutate();
    },
    patch(partial) {
      Object.assign(_value as object, partial);
      onMutate();
    },
    replace(next) {
      _value = next;
      onMutate();
    },
    reset() {
      _value = cloneDefaults(config.defaults);
      onMutate();
    },
    snapshot,
    /** Apply the configured sign-out policy. Called from `auth.signOut()` via
     *  `runSignOutHooks()`. */
    applySignOut() {
      applyPolicy(this, config.onSignOut);
    }
  };
  return store;
}

function applyPolicy<T>(store: SectionStore<T>, policy: SignOutPolicy<T> | undefined): void {
  if (!policy || policy === 'keep') return;
  if (policy === 'reset') {
    store.reset();
    return;
  }
  if (typeof policy === 'function') {
    store.replace(policy(store.snapshot()));
    return;
  }
  // Partial-merge policy: { onSignOut: { browserPushEnabled: false } } — handy
  // for "reset only this one field" without writing a function.
  if (typeof policy === 'object') {
    store.patch(policy as Partial<T>);
  }
}

/** Look up a previously-registered section. Returns null if unknown — never
 *  throws so plugin code can defensively probe for sibling-plugin sections. */
export function getSection<T = unknown>(name: string): SectionStore<T> | null {
  const reg = sections.get(name);
  return reg ? (reg.store as SectionStore<T>) : null;
}

/** Debug helper: list every registered section name. */
export function listSections(): string[] {
  return Array.from(sections.keys());
}

/** Hydrate every server-backed section from the backend.
 *
 * Called once on sign-in (and on hydrate of a persisted session). Does
 * a single bulk GET against ``/preferences``, then for each registered
 * section with ``persistence: 'server' | 'both'`` looks up its slice
 * and applies it via ``store.replace(parsed)``. Sections without a
 * server row keep their current (defaults / local) value.
 *
 * The ``parse`` hook still runs — the wire format is opaque JSON, so
 * the section's clamper is the only thing standing between a
 * corrupted server row and the rune-tracked state.
 *
 * Returns the set of section names that were hydrated, mostly for
 * testing / debug logging. */
export async function hydrateServerSections(): Promise<string[]> {
  const serverSections = Array.from(sections.entries()).filter(([, reg]) =>
    writesServer(modeOf(reg.config))
  );
  if (serverSections.length === 0) return [];
  const all = await fetchAllPreferences();
  const hydrated: string[] = [];
  for (const [name, reg] of serverSections) {
    const row = all[name];
    if (row === undefined) continue;
    const raw = row.value;
    let parsed: unknown;
    try {
      parsed = reg.config.parse ? reg.config.parse(raw) : mergeShallow(reg.config.defaults, raw as Partial<unknown>);
    } catch (err) {
      console.warn('[settings-registry] parse failed during hydrate', name, err);
      continue;
    }
    reg.store.replace(parsed);
    hydrated.push(name);
  }
  return hydrated;
}

/** Run all registered sign-out hooks. Called from `auth.signOut()`.
 *
 * Server-backed sections get their pending pushes flushed *before*
 * the sign-out policy fires — otherwise a debounced write could land
 * on the server after the next user signs in and accidentally clobber
 * their data with the previous user's state. The flush is best-effort
 * (auth token may already be gone). */
export function runSignOutHooks(): void {
  // Fire-and-forget: don't block sign-out on a slow network. The flush
  // itself is best-effort and tolerates a 401 (token already cleared).
  void flushAllPending();
  for (const reg of sections.values()) reg.store.applySignOut();
  flushPersist();
}

/** Test/dev helper — wipes the registry. NOT exported via the barrel. */
export function _resetRegistry(): void {
  if (pendingTimer !== null) {
    clearTimeout(pendingTimer);
    pendingTimer = null;
  }
  sections.clear();
}
