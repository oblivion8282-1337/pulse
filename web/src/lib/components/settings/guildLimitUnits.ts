/**
 * Umrechnung zwischen dem Wire-Wert eines Limits und seiner Anzeige.
 *
 * Backend speichert kbit/s und Bytes; die Oberfläche zeigt Mbit/s und MB/GB,
 * weil das die Zahlen sind, die ein Mensch eintippt. Beide Richtungen an einer
 * Stelle, damit Editor und Platzhalter nie auseinanderlaufen.
 */

const MB = 1024 * 1024;
const GB = 1024 * 1024 * 1024;

export type LimitKind = 'raw' | 'mbps' | 'mb' | 'gb' | 'resolution';

/** Von hoch nach niedrig; 'Native' = ungedeckelt. Deckt sich mit
 *  ``RESOLUTION_LADDER`` im Backend (``guild_limits.py``). */
export const RESOLUTION_LADDER = ['Native', '4K', '1440p', '1080p', '720p', '480p'];

/** Wire-Wert → Anzeige-String ('' wenn nichts gesetzt). */
export function toDisplay(wire: number | string | null, kind: LimitKind): string {
  if (wire === null || wire === undefined) return '';
  if (kind === 'resolution') return String(wire);
  const n = Number(wire);
  if (kind === 'mbps') return String(n / 1000);
  if (kind === 'mb') return String(Math.round((n / MB) * 100) / 100);
  if (kind === 'gb') return String(Math.round((n / GB) * 100) / 100);
  return String(n);
}

/** Anzeige-Wert → Wire (null wenn leer/ungültig). */
export function toWire(display: unknown, kind: LimitKind): number | string | null {
  if (kind === 'resolution') return display ? String(display) : null;
  if (display === '' || display === null || display === undefined) return null;
  const n = Number(display);
  if (!Number.isFinite(n)) return null;
  if (kind === 'mbps') return Math.round(n * 1000);
  if (kind === 'mb') return Math.round(n * MB);
  if (kind === 'gb') return Math.round(n * GB);
  return Math.round(n);
}
