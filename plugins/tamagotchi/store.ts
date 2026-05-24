/**
 * Tamagotchi pure-Logic — pet state + decay + action transforms.
 *
 * Hat keine Svelte- oder DOM-Abhängigkeit; das macht das Modul rein
 * testbar (auch wenn wir hier ohne Vitest leben) und entkoppelt die
 * Decay-Mathematik vom Widget. `frontend.ts` ist der einzige Aufrufer
 * + verbindet das hier via `registerSettingsSection` mit dem
 * Settings-Registry-Store.
 *
 * Decay-Modell: alle Stats sind 0–100. Hunger steigt mit der Zeit (höher =
 * hungriger), Glück + Energie sinken. Beim *Lesen* applizieren wir die
 * verstrichene Zeit seit `lastUpdatedAt` — kein `setInterval` nötig, kein
 * Aufwachen im Hintergrund. Action-Buttons rufen `applyDecay` zuerst auf,
 * damit der Decay-Anteil immer im persistierten State landet, *bevor* die
 * Aktion den Stat ändert (sonst ginge ein Tagesausfall verloren, wenn der
 * User direkt nach Reopen "Füttern" drückt).
 */

export type PetMood =
  | 'glücklich'
  | 'zufrieden'
  | 'müde'
  | 'hungrig'
  | 'traurig'
  | 'erschöpft';

export interface PetState {
  /** Anzeigename — der User kann ihn umbenennen. */
  name: string;
  /** 0 = satt, 100 = am Verhungern. */
  hunger: number;
  /** 0 = traurig, 100 = überglücklich. */
  happiness: number;
  /** 0 = erschöpft, 100 = ausgeschlafen. */
  energy: number;
  /** Epoch-ms des letzten Stat-Updates. Decay rechnet von hier an hoch. */
  lastUpdatedAt: number;
  /** Reserve für eine spätere "kann sterben"-Mechanik; heute immer `true`.
   *  In der UI nur als Reset-Hinweis benutzt. */
  alive: boolean;
}

/** Decay-Raten pro Stunde (Stat-Punkte/h). Konservativ — ein User, der
 *  einmal am Tag reinschaut, findet seinen Tamagotchi nicht tot vor. */
const HUNGER_RATE_PER_HOUR = 8;
const HAPPINESS_RATE_PER_HOUR = 4;
const ENERGY_RATE_PER_HOUR = 3;

const HOUR_MS = 3_600_000;

export const DEFAULT_PET: PetState = {
  name: 'Pipsi',
  hunger: 30,
  happiness: 80,
  energy: 70,
  lastUpdatedAt: 0,
  alive: true
};

function clamp(v: number, lo = 0, hi = 100): number {
  if (!Number.isFinite(v)) return lo;
  return Math.max(lo, Math.min(hi, v));
}

/** Wende den Zeit-Decay seit `state.lastUpdatedAt` auf das State-Snapshot an.
 *  Pure — der Aufrufer muss das Ergebnis selbst persistieren. */
export function applyDecay(state: PetState, now: number = Date.now()): PetState {
  // Erstaufruf oder Uhr-Backspring: setze einfach den Zeitstempel und gib
  // den State unverändert zurück (kein negativer Decay).
  if (!state.lastUpdatedAt || now <= state.lastUpdatedAt) {
    return { ...state, lastUpdatedAt: now };
  }
  const elapsedHours = (now - state.lastUpdatedAt) / HOUR_MS;
  return {
    ...state,
    hunger: clamp(state.hunger + elapsedHours * HUNGER_RATE_PER_HOUR),
    happiness: clamp(state.happiness - elapsedHours * HAPPINESS_RATE_PER_HOUR),
    energy: clamp(state.energy - elapsedHours * ENERGY_RATE_PER_HOUR),
    lastUpdatedAt: now
  };
}

/** Füttern: -30 Hunger, +5 Glück (gutes Essen freut). Decay first. */
export function feed(state: PetState, now: number = Date.now()): PetState {
  const s = applyDecay(state, now);
  return {
    ...s,
    hunger: clamp(s.hunger - 30),
    happiness: clamp(s.happiness + 5),
    lastUpdatedAt: now
  };
}

/** Spielen: +25 Glück, -15 Energie, +5 Hunger (Kalorien!). Decay first. */
export function play(state: PetState, now: number = Date.now()): PetState {
  const s = applyDecay(state, now);
  return {
    ...s,
    happiness: clamp(s.happiness + 25),
    energy: clamp(s.energy - 15),
    hunger: clamp(s.hunger + 5),
    lastUpdatedAt: now
  };
}

/** Schlafen: +50 Energie. Skipped 4h Zeit (entsprechender Decay greift
 *  zuerst, danach +50). Hunger steigt durch die simulierte Zeit also leicht. */
export function sleep(state: PetState, now: number = Date.now()): PetState {
  const SLEEP_DURATION_MS = 4 * HOUR_MS;
  // Lass den Schlafzeitraum die Stats normal decayen — Hunger steigt,
  // Glück sinkt leicht — dann gib die Energie obendrauf.
  const fastForwarded = applyDecay(state, now + SLEEP_DURATION_MS);
  return {
    ...fastForwarded,
    energy: clamp(fastForwarded.energy + 50),
    // Den effektiven "jetzt" trotzdem auf den realen Zeitpunkt setzen,
    // sonst kollidiert der nächste Decay-Read mit einer Zukunfts-Zeit.
    lastUpdatedAt: now
  };
}

/** Hartes Reset auf `DEFAULT_PET` mit aktuellem Zeitstempel. */
export function reset(now: number = Date.now()): PetState {
  return { ...DEFAULT_PET, lastUpdatedAt: now };
}

/** Mood-Ableitung — nimmt das schlechteste Bedürfnis als dominanten Mood,
 *  fällt auf `happiness` als Sentiment-Default zurück. Verwendet im Widget. */
export function moodOf(state: PetState): PetMood {
  if (state.hunger >= 80) return 'hungrig';
  if (state.energy <= 20) return 'erschöpft';
  if (state.happiness <= 25) return 'traurig';
  if (state.energy <= 40) return 'müde';
  if (state.happiness >= 70) return 'glücklich';
  return 'zufrieden';
}

/** Emoji-Pool fürs Widget — wird vom Mood abgeleitet. Bewusst keine
 *  SVGs/Sprites: ein Emoji passt zur Pulse-Tonalität (Dark-Themed, leicht
 *  verspielt) und kostet null Bundle-Bytes. */
export function emojiOf(mood: PetMood): string {
  switch (mood) {
    case 'glücklich':
      return '🐣';
    case 'zufrieden':
      return '🐤';
    case 'müde':
      return '😴';
    case 'hungrig':
      return '🍽️';
    case 'traurig':
      return '🥺';
    case 'erschöpft':
      return '💤';
  }
}

/** Defensives Parsen einer persistierten Section. Drops unbekannte Keys
 *  und clamped jeden Stat in den 0..100-Bereich — schützt gegen
 *  korrumpierten localStorage-Inhalt. */
export function parsePet(raw: unknown): PetState {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_PET, lastUpdatedAt: Date.now() };
  const r = raw as Record<string, unknown>;
  const name = typeof r.name === 'string' && r.name.trim().length > 0
    ? r.name.slice(0, 32)
    : DEFAULT_PET.name;
  return {
    name,
    hunger: clamp(toNum(r.hunger, DEFAULT_PET.hunger)),
    happiness: clamp(toNum(r.happiness, DEFAULT_PET.happiness)),
    energy: clamp(toNum(r.energy, DEFAULT_PET.energy)),
    lastUpdatedAt: toNum(r.lastUpdatedAt, Date.now()),
    alive: r.alive !== false
  };
}

function toNum(v: unknown, fallback: number): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}
