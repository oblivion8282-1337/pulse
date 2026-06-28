/**
 * Gerätelokales Gedächtnis: welcher Invite-Code führte zu welcher Community,
 * NACHDEM der User über ihn beigetreten ist.
 *
 * Warum: Die Invite-Karte (`InviteEmbed`) graut ihren „Beitreten"-Button nur
 * aus, wenn sie die Mitgliedschaft erkennt. Beim Self-Host hing das an der
 * Invite-Preview, die nach dem Beitritt aber nicht mehr ladbar sein kann
 * (verbrauchter / abgelaufener Code) → der Button blieb dann dauerhaft klickbar,
 * obwohl man längst Mitglied ist. Dieser Marker ist die zuverlässige Quelle:
 * wer über den Code beigetreten ist, sieht „Beigetreten" — auch nach Reload, in
 * einem anderen Tab oder wenn die Preview tot ist.
 *
 * Persistiert in localStorage (gerätelokal, reicht für eine UI-Zustands-Marke).
 */

const LS_KEY = 'pulse.joinedInvites';

class JoinedInvites {
  // code → guildId
  private _map = $state<Record<string, string>>({});

  constructor() {
    this._map = this._load();
  }

  /** Guild-ID, der dieser Code zugeordnet ist — oder undefined, falls nie beigetreten. */
  guildIdFor(code: string): string | undefined {
    return this._map[code];
  }

  /** Nach erfolgreichem Beitritt aufrufen. Idempotent. */
  markJoined(code: string, guildId: string): void {
    if (typeof window === 'undefined' || !code || !guildId) return;
    if (this._map[code] === guildId) return;
    this._map = { ...this._map, [code]: guildId };
    try {
      window.localStorage.setItem(LS_KEY, JSON.stringify(this._map));
    } catch {
      /* Quota / Private-Browsing: nur der persistente Teil entfällt */
    }
  }

  private _load(): Record<string, string> {
    if (typeof window === 'undefined') return {};
    try {
      return JSON.parse(window.localStorage.getItem(LS_KEY) || '{}') as Record<string, string>;
    } catch {
      return {};
    }
  }
}

export const joinedInvites = new JoinedInvites();
