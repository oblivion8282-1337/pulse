/**
 * Session-Token-Store für Self-Host-Server — Phase 4.1 Foundation
 *
 * In-Memory ONLY — NIEMALS persistieren (XSS-Härtung).
 * Verloren beim Tab-Refresh; Phase 4.2 macht Re-Auth via Cert-Flow.
 *
 * Für Cloud (Pulse Cloud) laufen Tokens weiterhin über storage.ts
 * (dcc.tokens.access/refresh) — dieser Store ist nur für Self-Host-
 * Instanzen die keine JWT-Rotation über den zentralen Auth-Service haben.
 */

type TokenEntry = {
  token: string;
  expiresAt: number; // Unix ms
};

class SessionTokens {
  readonly #map = new Map<string, TokenEntry>();
  #onChange: ((serverId: string, action: 'set' | 'clear') => void) | null = null;

  /** Listener für den proaktiven Refresh-Scheduler (self-host-reauth.ts) —
   *  feuert bei jedem set/clear, damit der Scheduler den Refresh-Timer eines
   *  Servers an dessen aktuelles Ablaufdatum koppeln kann. */
  setChangeListener(fn: ((serverId: string, action: 'set' | 'clear') => void) | null): void {
    this.#onChange = fn;
  }

  set(serverId: string, token: string, expiresAt: number): void {
    this.#map.set(serverId, { token, expiresAt });
    this.#onChange?.(serverId, 'set');
  }

  get(serverId: string): TokenEntry | undefined {
    return this.#map.get(serverId);
  }

  clear(serverId: string): void {
    this.#map.delete(serverId);
    this.#onChange?.(serverId, 'clear');
  }

  isValid(serverId: string): boolean {
    const entry = this.#map.get(serverId);
    if (!entry) return false;
    return Date.now() < entry.expiresAt;
  }

  /** Löscht alle abgelaufenen Tokens (GC, optional aufzurufen). */
  purgeExpired(): void {
    const now = Date.now();
    for (const [id, entry] of this.#map) {
      if (now >= entry.expiresAt) this.#map.delete(id);
    }
  }
}

export const sessionTokens = new SessionTokens();
