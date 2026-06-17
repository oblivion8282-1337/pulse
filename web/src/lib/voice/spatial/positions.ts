/**
 * Listener-local spatial positions, persisted per channel in localStorage.
 *
 * These are purely your own listening layout — never synced to the server or
 * other participants (each person arranges the room around themselves). Keyed
 * `channelId → userId → {azimuth°, distance m}`.
 */
const STORAGE_KEY = 'dcc.spatial.positions';

export interface SpatialPos {
  /** 0° = in front, +90° = to your right, −90° = left. */
  az: number;
  /** Distance in metres. */
  dist: number;
}

type Store = Record<string, Record<string, SpatialPos>>;

function readAll(): Store {
  if (typeof localStorage === 'undefined') return {};
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as Store) : {};
  } catch {
    return {};
  }
}

function writeAll(store: Store): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
  } catch {
    /* quota — positions are non-critical, drop silently */
  }
}

/** All saved positions for a channel (userId → position). */
export function loadChannelPositions(channelId: string): Record<string, SpatialPos> {
  return readAll()[channelId] ?? {};
}

/** Persist one participant's position within a channel. */
export function saveChannelPosition(channelId: string, userId: string, pos: SpatialPos): void {
  const store = readAll();
  (store[channelId] ??= {})[userId] = pos;
  writeAll(store);
}
