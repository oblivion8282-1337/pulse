/**
 * Server-side persistence adapter for the settings-section registry
 * (Plugin-System Schritt 3b).
 *
 * Sections with ``persistence: 'server' | 'both'`` route their reads
 * through ``hydrateServerSection`` on sign-in and their writes through
 * ``schedulePushSection`` after every mutation. The registry is the
 * caller: this module is intentionally I/O-only, no rune state.
 *
 * Persistence semantics:
 *   - On sign-in, ``hydrateAll()`` is called once with the full list
 *     of server-backed sections. It does one bulk ``GET /preferences``,
 *     finds the slice for each section, and applies it via the
 *     supplied ``replace`` callback. Sections without a server row
 *     keep their current (defaults / local-storage) value.
 *   - Writes are debounced per-section (``PUSH_DEBOUNCE_MS``) so a
 *     slider drag collapses to one PUT.
 *   - Failures are logged + swallowed. The local store of record is
 *     either localStorage (mode `'both'`) or in-memory (mode `'server'`)
 *     — a missed server push only loses cross-device sync until the
 *     next mutation, not the current device's state.
 */

import { CHAT_BASE } from '$lib/api/client';
import { loadTokens } from '$lib/api/storage';

const PUSH_DEBOUNCE_MS = 2500;

interface PendingPush {
  timer: ReturnType<typeof setTimeout>;
  /** Latest snapshot to push when the timer fires. Overwritten on
   *  every schedulePushSection call so we always send the freshest
   *  state. */
  snapshot: () => unknown;
}

const pending = new Map<string, PendingPush>();

interface PreferenceRow {
  value: unknown;
  version: number;
}

async function authFetch(
  path: string,
  init?: RequestInit
): Promise<Response | null> {
  const tokens = loadTokens();
  if (!tokens) return null;
  const headers: Record<string, string> = {
    ...(init?.headers as Record<string, string> | undefined),
    Authorization: `Bearer ${tokens.access_token}`
  };
  if (init?.body !== undefined && !headers['Content-Type']) {
    headers['Content-Type'] = 'application/json';
  }
  try {
    return await fetch(`${CHAT_BASE}${path}`, { ...init, headers });
  } catch (err) {
    console.warn('[settings-registry] server-sync fetch failed', path, err);
    return null;
  }
}

/**
 * One-shot bulk hydration. Returns ``{section_name: row}`` for the
 * requested sections; absent sections are simply omitted. Callers
 * apply the slices via the registry's ``replace`` API.
 */
export async function fetchAllPreferences(): Promise<Record<string, PreferenceRow>> {
  const resp = await authFetch('/preferences', { method: 'GET' });
  if (!resp) return {};
  if (!resp.ok) {
    console.warn('[settings-registry] GET /preferences failed', resp.status);
    return {};
  }
  try {
    const data = (await resp.json()) as unknown;
    if (data && typeof data === 'object' && !Array.isArray(data)) {
      // Trust the route's response shape — it's typed on the backend.
      return data as Record<string, PreferenceRow>;
    }
  } catch (err) {
    console.warn('[settings-registry] GET /preferences parse failed', err);
  }
  return {};
}

/**
 * Schedule a debounced PUT for one section. Repeated calls within
 * ``PUSH_DEBOUNCE_MS`` collapse to a single request that captures the
 * *latest* snapshot at firing time.
 *
 * Callers pass a snapshot *function* (not a value) so the registry's
 * proxy-stripping ``snapshot()`` runs at flush time — capturing the
 * current rune-state, not whatever was in scope when the timer was
 * set.
 */
export function schedulePushSection(
  sectionName: string,
  snapshot: () => unknown
): void {
  const existing = pending.get(sectionName);
  if (existing) clearTimeout(existing.timer);
  const timer = setTimeout(() => {
    pending.delete(sectionName);
    void pushSectionNow(sectionName, snapshot());
  }, PUSH_DEBOUNCE_MS);
  pending.set(sectionName, { timer, snapshot });
}

/** Force a flush of one section's pending push. */
export async function flushSection(sectionName: string): Promise<void> {
  const p = pending.get(sectionName);
  if (!p) return;
  clearTimeout(p.timer);
  pending.delete(sectionName);
  await pushSectionNow(sectionName, p.snapshot());
}

/** Force a flush of every pending push (called on sign-out). */
export async function flushAllPending(): Promise<void> {
  const entries = Array.from(pending.entries());
  pending.clear();
  await Promise.all(
    entries.map(([name, p]) => {
      clearTimeout(p.timer);
      return pushSectionNow(name, p.snapshot());
    })
  );
}

async function pushSectionNow(
  sectionName: string,
  value: unknown
): Promise<void> {
  const resp = await authFetch(`/preferences/${sectionName}`, {
    method: 'PUT',
    body: JSON.stringify({ value })
  });
  if (!resp) return;
  if (!resp.ok) {
    console.warn(
      '[settings-registry] PUT /preferences/%s failed: %d',
      sectionName,
      resp.status
    );
  }
}

/** Delete a server-side section (used by sign-out policies that need
 *  to clear the cross-device slot — most plugins want to *keep* server
 *  state across sign-outs, so this is opt-in). */
export async function deleteServerSection(sectionName: string): Promise<void> {
  const p = pending.get(sectionName);
  if (p) {
    clearTimeout(p.timer);
    pending.delete(sectionName);
  }
  const resp = await authFetch(`/preferences/${sectionName}`, {
    method: 'DELETE'
  });
  if (resp && !resp.ok) {
    console.warn(
      '[settings-registry] DELETE /preferences/%s failed: %d',
      sectionName,
      resp.status
    );
  }
}
