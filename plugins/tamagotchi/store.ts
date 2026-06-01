/**
 * Tamagotchi pure type definitions + client-side mechanics mirror (v0.3.0).
 *
 * Der Server (``backend.py`` + ``mechanics.py``) ist die Source-of-Truth für
 * den persistierten State. Diese Datei spiegelt die **pure** Mechanik für die
 * **Anzeige**: zwischen zwei Server-Updates rechnet das Widget den Zeit-Decay
 * lokal weiter (sichtbar sinkende Bars) und leitet Tod/Evolution ab — ohne
 * Server-Roundtrip. Die Konstanten MÜSSEN mit ``plugins/tamagotchi/
 * mechanics.py`` synchron bleiben (gleiches Muster wie das permissions-
 * bitfield: Python = Quelle, TS = Spiegel).
 */

export type PetMood =
  | 'glücklich'
  | 'zufrieden'
  | 'müde'
  | 'hungrig'
  | 'traurig'
  | 'erschöpft';

/** Server-shared Pet-State (gespiegelt aus ``mechanics.py::DEFAULT_STATE``).
 *  Stats sind 0–100. ``lastUpdatedAt`` ist ein ISO-8601-String. */
export interface PetState {
  name: string;
  hunger: number;
  happiness: number;
  energy: number;
  alive: boolean;
  xp: number;
  level: number;
  lastUpdatedAt: string;
}

// --- Konstanten (Spiegel von mechanics.py) ---------------------------------
const DECAY_PER_HOUR = { hunger: 10, happiness: 6, energy: 5 } as const;
const DEATH_GRACE_HOURS = 12;
const XP_PER_ACTION = 10;
const BIRTH_SENTINEL = '1970-01-01T00:00:00+00:00';

export const DEFAULT_PET: PetState = {
  name: 'Tamagotchi',
  hunger: 80,
  happiness: 80,
  energy: 80,
  alive: true,
  xp: 0,
  level: 1,
  lastUpdatedAt: BIRTH_SENTINEL
};

function clamp(v: number, lo = 0, hi = 100): number {
  if (!Number.isFinite(v)) return lo;
  return Math.max(lo, Math.min(hi, v));
}

function toNum(v: unknown, fallback: number): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}

// --- XP / Level (Spiegel) --------------------------------------------------

/** Kumulative XP, um ``level`` zu erreichen (0/100/300/600/1000/…). */
export function xpForLevel(level: number): number {
  return level <= 1 ? 0 : 50 * (level - 1) * level;
}

/** Höchstes Level, dessen Schwelle ``xp`` erreicht. */
export function levelForXp(xp: number): number {
  let level = 1;
  while (xpForLevel(level + 1) <= xp) level += 1;
  return level;
}

/** XP-Fortschritt im aktuellen Level → für die Widget-Progress-Bar. */
export function xpProgress(state: PetState): { into: number; span: number; pct: number } {
  const cur = xpForLevel(state.level);
  const next = xpForLevel(state.level + 1);
  const into = Math.max(0, state.xp - cur);
  const span = Math.max(1, next - cur);
  return { into, span, pct: clamp((into / span) * 100) };
}

// --- Decay / Tod (Spiegel, für die Live-Anzeige) ---------------------------

function _isUnborn(state: PetState): boolean {
  return state.lastUpdatedAt === BIRTH_SENTINEL;
}

function _hoursSince(iso: string, nowMs: number): number {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return 0;
  const h = (nowMs - then) / 3_600_000;
  return h > 0 ? h : 0;
}

/** Stats lokal weiter-decayen für die Anzeige zwischen Server-Updates.
 *  Ungeborenes Pet (Sentinel) bleibt unverändert. */
export function applyDecay(state: PetState, nowMs: number): PetState {
  if (_isUnborn(state)) return state;
  const h = _hoursSince(state.lastUpdatedAt, nowMs);
  if (h <= 0) return state;
  return {
    ...state,
    hunger: clamp(state.hunger - DECAY_PER_HOUR.hunger * h),
    happiness: clamp(state.happiness - DECAY_PER_HOUR.happiness * h),
    energy: clamp(state.energy - DECAY_PER_HOUR.energy * h)
  };
}

/** Lokale Tod-Ableitung (Spiegel ``should_be_dead``) — fürs Tod-Overlay,
 *  bevor ein Server-Update den State autoritativ auf ``alive:false`` setzt. */
export function shouldBeDead(state: PetState, nowMs: number): boolean {
  if (_isUnborn(state)) return false;
  const timeToZero = Math.max(0, state.hunger) / DECAY_PER_HOUR.hunger;
  return _hoursSince(state.lastUpdatedAt, nowMs) >= timeToZero + DEATH_GRACE_HOURS;
}

/** Effektiver Lebend-Status fürs Widget: persistiert tot ODER lokal über die
 *  Tod-Schwelle hinaus vernachlässigt. */
export function isAlive(state: PetState, nowMs: number): boolean {
  return state.alive && !shouldBeDead(state, nowMs);
}

// --- Mood / Avatar ---------------------------------------------------------

/** Defensives Parsen eines Server-State-Blobs. */
export function parsePet(raw: unknown): PetState {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_PET };
  const r = raw as Record<string, unknown>;
  const name =
    typeof r.name === 'string' && r.name.trim().length > 0
      ? r.name.slice(0, 32)
      : DEFAULT_PET.name;
  const xp = Math.max(0, Math.round(toNum(r.xp, 0)));
  return {
    name,
    hunger: clamp(toNum(r.hunger, DEFAULT_PET.hunger)),
    happiness: clamp(toNum(r.happiness, DEFAULT_PET.happiness)),
    energy: clamp(toNum(r.energy, DEFAULT_PET.energy)),
    alive: typeof r.alive === 'boolean' ? r.alive : true,
    xp,
    level: levelForXp(xp),
    lastUpdatedAt:
      typeof r.lastUpdatedAt === 'string' ? r.lastUpdatedAt : DEFAULT_PET.lastUpdatedAt
  };
}

/** Mood-Ableitung — schlechtestes Bedürfnis dominiert. Hoher Wert = gut. */
export function moodOf(state: PetState): PetMood {
  if (state.hunger <= 20) return 'hungrig';
  if (state.energy <= 20) return 'erschöpft';
  if (state.happiness <= 25) return 'traurig';
  if (state.energy <= 40) return 'müde';
  if (state.happiness >= 70) return 'glücklich';
  return 'zufrieden';
}

/** Kleines Mood-Badge-Emoji (Zustand). */
export function moodEmoji(mood: PetMood): string {
  switch (mood) {
    case 'glücklich':
      return '😊';
    case 'zufrieden':
      return '🙂';
    case 'müde':
      return '🥱';
    case 'hungrig':
      return '🍽️';
    case 'traurig':
      return '🥺';
    case 'erschöpft':
      return '💤';
  }
}

/** Großer Avatar — Tod überschreibt, sonst Evolutionsstufe nach Level
 *  (🥚 L1–2 → 🐣 L3–5 → 🐤 L6–9 → 🐔 L10+). */
export function avatarOf(state: PetState, alive: boolean): string {
  if (!alive) return '💀';
  if (state.level >= 10) return '🐔';
  if (state.level >= 6) return '🐤';
  if (state.level >= 3) return '🐣';
  return '🥚';
}

export { XP_PER_ACTION };
