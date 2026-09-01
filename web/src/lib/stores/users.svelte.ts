import { request } from '$lib/api/client';
import { activeServer } from '$lib/stores/active-server.svelte';

export type UserSummary = {
  id: string;
  username: string;
  display_name: string | null;
  avatar_url: string | null;
  /** Hex-Namensfarbe aus den Profileinstellungen; optional, da ältere
   *  Seed-Aufrufer (und gemockte Test-Payloads) sie nicht mitsenden. */
  profile_color?: string | null;
  /** Optionale zweite Farbe für einen Namens-Verlauf (profile_color → diese). */
  profile_color_secondary?: string | null;
  /** Richtung des Verlaufs in Grad (0–360); fehlend/null = Default 90° (links→rechts). */
  profile_gradient_angle?: number | null;
};

/** Reserved system user-id. Backend authors automated moderation notices
 *  (e.g. the reporter's "your report was handled" DM) as this id; we render it
 *  as the neutral "Pulse" sender. Kept in sync with the backend's
 *  ``PULSE_SYSTEM_USER_ID`` (0 — never a real snowflake). */
export const SYSTEM_USER_ID = '0';

const PULSE_SYSTEM_PROFILE: UserSummary = {
  id: SYSTEM_USER_ID,
  username: 'pulse',
  display_name: 'Pulse',
  avatar_url: null
};

class UserCacheStore {
  byId = $state<Record<string, UserSummary>>({ [SYSTEM_USER_ID]: PULSE_SYSTEM_PROFILE });

  private pending = new Set<string>();
  // Ids the server confirmed it has no record of (deleted / never existed).
  // Without this, `queue(id)` for such an id never short-circuits — and
  // `messageRender.userMentionLabel` re-queues on every render of an
  // `@unknown` mention, so each re-render fires another `/users` request.
  private unknown = new Set<string>();
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;

  get(id: string): UserSummary | null {
    return this.byId[id] ?? null;
  }

  /** Name aus dem Cache; ohne Cache-Eintrag (oder ohne ID, z. B. LiveKit-
   *  Identity nicht parsbar) der `fallback` — sonst `…`. */
  displayName(id: string | null | undefined, fallback?: string): string {
    const u = id ? this.byId[id] : null;
    if (!u) return fallback ?? `…`;
    return u.display_name ?? u.username;
  }

  /** Queue an ID for batch fetch; deduped and debounced 50ms. Already-cached,
   *  in-flight and known-absent ids short-circuit. */
  queue(id: string): void {
    if (this.byId[id] || this.pending.has(id) || this.unknown.has(id)) return;
    this.pending.add(id);
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => void this._flush(), 50);
  }

  private async _flush(): Promise<void> {
    if (this.pending.size === 0) return;
    const ids = [...this.pending].slice(0, 100);
    ids.forEach((id) => this.pending.delete(id));
    this.debounceTimer = null;
    // Auf einem Self-Host kennt die Cloud-Auth die per-Instanz-IDs nicht →
    // Namen vom Self-Host (endpoint 'chat') holen statt von der Cloud. Auch
    // fuers Fehler-Log unten gebraucht, daher vor dem try berechnet.
    const onSelfHost = activeServer.current ? !activeServer.current.isCloud : false;
    try {
      const result = await request<UserSummary[]>(
        `/users?ids=${ids.join(',')}`,
        { endpoint: onSelfHost ? 'chat' : 'auth' }
      );
      const returned = new Set<string>();
      for (const u of result) {
        this.byId[u.id] = u;
        returned.add(u.id);
      }

      let unresolved = ids.filter((id) => !returned.has(id));
      // Cloud-Fallback: was der Self-Host nicht kennt (z.B. DM-Empfänger /
      // Freunde = Cloud-User), bei der Cloud-Auth nachschlagen. Verhindert eine
      // Regression der DM-/Friends-Namen, während man auf einem Self-Host ist.
      // (`endpoint:'auth'` ist immer Cloud-relativ.)
      if (onSelfHost && unresolved.length > 0) {
        try {
          const cloud = await request<UserSummary[]>(
            `/users?ids=${unresolved.join(',')}`,
            { endpoint: 'auth' }
          );
          for (const u of cloud) {
            this.byId[u.id] = u;
            returned.add(u.id);
          }
          unresolved = unresolved.filter((id) => !returned.has(id));
        } catch (err) {
          // transient — bleibt retrybar (nicht tombstonen)
          console.warn(
            `[users] Cloud-Nachschlag für ${unresolved.length} unbekannte ID(s) fehlgeschlagen`,
            err
          );
          unresolved = [];
        }
      }
      // Tombstone ids no source returned so we stop re-fetching them. Only on a
      // *successful* response — a network failure leaves them un-tombstoned
      // (retryable) via the empty-list assignment above / the outer catch.
      for (const id of unresolved) this.unknown.add(id);
    } catch (err) {
      // Frueher stumm. Das war die teuerste Zeile der Datei: schlaegt dieser
      // eine Request fehl, zeigt die Oberflaeche bei JEDEM fremden Autor nur
      // noch „…" — ohne Log, ohne Toast, ohne Spur. Genau so ist der Fehler
      // 2026-07-27 auf einem Self-Host aufgetreten und war von aussen nicht
      // zuzuordnen. Die Namen kommen ueber diesen REST-Aufruf, die Nachrichten
      // selbst ueber die WebSocket-Verbindung — er kann also allein brechen,
      // ohne dass sonst etwas auffaellt.
      //
      // Bewusst nur ein Log, kein Toast: der Aufruf laeuft im Hintergrund und
      // wiederholt sich beim naechsten Rendern; eine Meldung pro Versuch waere
      // Laerm. Die Endpunkt-Angabe unterscheidet Self-Host (chat) von Cloud
      // (auth) — das ist die Information, die bei der Zuordnung fehlte.
      console.warn(
        `[users] Namen für ${ids.length} ID(s) nicht ladbar ` +
          `(endpoint=${onSelfHost ? 'chat' : 'auth'}) — Anzeige bleibt bei „…"`,
        err
      );
    }
    // If more were added during the flush, schedule another round.
    if (this.pending.size > 0) {
      this.debounceTimer = setTimeout(() => void this._flush(), 50);
    }
  }

  seed(users: UserSummary[]): void {
    // Only write state if something actually changed to avoid re-render loops.
    const changed = users.filter((u) => {
      const cached = this.byId[u.id];
      return !cached || cached.username !== u.username ||
        cached.display_name !== u.display_name || cached.avatar_url !== u.avatar_url ||
        (u.profile_color !== undefined && cached.profile_color !== u.profile_color) ||
        (u.profile_color_secondary !== undefined &&
          cached.profile_color_secondary !== u.profile_color_secondary) ||
        (u.profile_gradient_angle !== undefined &&
          cached.profile_gradient_angle !== u.profile_gradient_angle);
    });
    if (changed.length === 0) return;
    const next = { ...this.byId };
    // Spread-Merge: Seeds ohne profile_color (undefined) lassen eine bereits
    // gecachte Farbe stehen; explizites null überschreibt (Farbe entfernt).
    for (const u of changed) next[u.id] = { ...next[u.id], ...u };
    this.byId = next;
  }

  clear(): void {
    // Keep the "Pulse" system profile across server switches / sign-out so
    // system DMs always render with a name.
    this.byId = { [SYSTEM_USER_ID]: PULSE_SYSTEM_PROFILE };
    this.pending.clear();
    this.unknown.clear();
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
  }
}

export const userCache = new UserCacheStore();
