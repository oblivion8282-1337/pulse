/**
 * Shared response-parsing helpers for the API clients (`client.ts`,
 * `cookie-client.ts`). Single source of truth — both bearer and cookie clients
 * parse error bodies identically. Pure, no imports → safe to import from either
 * client without a cycle.
 */

export function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export function extractDetail(data: unknown): string | null {
  if (data && typeof data === 'object' && 'detail' in (data as Record<string, unknown>)) {
    const d = (data as { detail: unknown }).detail;
    if (typeof d === 'string') return d;
  }
  return null;
}
