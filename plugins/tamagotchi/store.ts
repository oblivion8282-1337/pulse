/**
 * Tamagotchi pure type definitions (Plugin-System PR3 "Server-shared").
 *
 * Vor PR3 lebte hier die Pure-Logic für den client-side Pet-State
 * (Decay, Action-Transforms). Mit PR3 ist die Logic auf den Server
 * gewandert — der Backend-Handler in ``backend.py`` mutiert atomar,
 * der Frontend-Code wendet keine Decay-Mathematik mehr an. Was bleibt:
 * Type-Definitionen + ein defensive Parser fürs Server-Response.
 *
 * Mood/Emoji-Helpers werden weiterhin im Widget benutzt — sie sind
 * pure und brauchen keinen Server-Roundtrip.
 */

export type PetMood =
  | 'glücklich'
  | 'zufrieden'
  | 'müde'
  | 'hungrig'
  | 'traurig'
  | 'erschöpft';

/** Server-shared Pet-State (gespiegelt aus `plugins/tamagotchi/backend.py`
 *  ``DEFAULT_STATE`` + ``TamagotchiState``-Pydantic-Schema).
 *
 *  Stats sind 0–100. ``lastUpdatedAt`` ist ein ISO-8601-String (vom
 *  Backend mit ``+00:00``-Suffix). */
export interface PetState {
  name: string;
  hunger: number;
  happiness: number;
  energy: number;
  lastUpdatedAt: string;
}

export const DEFAULT_PET: PetState = {
  name: 'Tamagotchi',
  hunger: 80,
  happiness: 80,
  energy: 80,
  lastUpdatedAt: '1970-01-01T00:00:00+00:00'
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

/** Defensives Parsen eines Server-State-Blobs. Drops unbekannte Keys
 *  und clampt jeden Stat in den 0..100-Bereich. */
export function parsePet(raw: unknown): PetState {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_PET };
  const r = raw as Record<string, unknown>;
  const name =
    typeof r.name === 'string' && r.name.trim().length > 0
      ? r.name.slice(0, 32)
      : DEFAULT_PET.name;
  return {
    name,
    hunger: clamp(toNum(r.hunger, DEFAULT_PET.hunger)),
    happiness: clamp(toNum(r.happiness, DEFAULT_PET.happiness)),
    energy: clamp(toNum(r.energy, DEFAULT_PET.energy)),
    lastUpdatedAt:
      typeof r.lastUpdatedAt === 'string' ? r.lastUpdatedAt : DEFAULT_PET.lastUpdatedAt
  };
}

/** Mood-Ableitung — nimmt das schlechteste Bedürfnis als dominanten Mood,
 *  fällt auf `happiness` als Sentiment-Default zurück. Verwendet im Widget. */
export function moodOf(state: PetState): PetMood {
  // PR3-Schema: hunger HOCH = satt (war pre-PR3 umgekehrt). Hier:
  // niedriger Hunger-Wert = hungrig.
  if (state.hunger <= 20) return 'hungrig';
  if (state.energy <= 20) return 'erschöpft';
  if (state.happiness <= 25) return 'traurig';
  if (state.energy <= 40) return 'müde';
  if (state.happiness >= 70) return 'glücklich';
  return 'zufrieden';
}

/** Emoji-Pool fürs Widget. Bewusst keine SVGs/Sprites — Emoji passt zur
 *  Pulse-Tonalität (Dark-Themed, leicht verspielt). */
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
