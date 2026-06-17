/**
 * Per-viewer "I want to watch this tile" set, granular per source kind.
 *
 * Default-empty: a new publisher does NOT auto-mount a player — the viewer
 * has to click a badge in the sidebar or on a voice-participant-tile first.
 * Closing a tile drops the entry, so the next time the same publisher starts
 * (or stops + restarts) it requires a fresh click.
 *
 * Four kinds — each pairs with a different presence source + tile component:
 *   kind="hq"     → id = user id (snowflake) — HQ WHEP stream     → WhepPlayer
 *   kind="screen" → id = LiveKit participant identity              → ScreenShareTile
 *   kind="cam"    → id = LiveKit participant identity              → CameraTile
 *   kind="party"  → id = party_id (several parties per channel)     → WatchPartyTile
 *
 * Keyed `<kind>::<channelId>::<id>` so a single Set carries all four kinds.
 * Cleared on channel switch via `resetChannel`. The view also calls
 * `pruneChannel` after every presence-update to drop tiles whose publisher
 * is no longer live — so a pause+restart forces a new click.
 */
export type TileKind = 'hq' | 'screen' | 'cam' | 'party';

class OpenedTiles {
  #set = $state<Set<string>>(new Set());
  // Zuletzt betretener Stream-Channel — unterscheidet „echter Channel-Wechsel"
  // (Opens des alten Channels schließen) von „nur weg- und zurücknavigiert"
  // (Opens behalten → HQ-Stream lief im Hintergrund weiter, Bild sofort zurück).
  #activeChannel: string | null = null;

  #key(kind: TileKind, channelId: string, id: string): string {
    return `${kind}::${channelId}::${id}`;
  }

  isOpen(kind: TileKind, channelId: string, id: string): boolean {
    return this.#set.has(this.#key(kind, channelId, id));
  }

  isOpenParty(channelId: string, partyId: string): boolean {
    return this.isOpen('party', channelId, partyId);
  }

  open(kind: TileKind, channelId: string, id: string): void {
    const k = this.#key(kind, channelId, id);
    if (this.#set.has(k)) return;
    this.#set = new Set(this.#set).add(k);
  }

  openParty(channelId: string, partyId: string): void {
    this.open('party', channelId, partyId);
  }

  close(kind: TileKind, channelId: string, id: string): void {
    const k = this.#key(kind, channelId, id);
    if (!this.#set.has(k)) return;
    const next = new Set(this.#set);
    next.delete(k);
    this.#set = next;
  }

  closeParty(channelId: string, partyId: string): void {
    this.close('party', channelId, partyId);
  }

  /** Alle offenen Einträge eines Kinds als {channelId, id} — Treiber für den
   *  HQ-Stream-Keep-Alive-Abgleich (welche Streams am Leben bleiben sollen). */
  entriesOfKind(kind: TileKind): { channelId: string; id: string }[] {
    const prefix = `${kind}::`;
    const out: { channelId: string; id: string }[] = [];
    for (const k of this.#set) {
      if (!k.startsWith(prefix)) continue;
      const rest = k.slice(prefix.length);
      const sep = rest.indexOf('::');
      if (sep < 0) continue;
      out.push({ channelId: rest.slice(0, sep), id: rest.slice(sep + 2) });
    }
    return out;
  }

  /** Whether any tile is open for this channel (any kind, any id). */
  hasAny(channelId: string): boolean {
    const marker = `::${channelId}::`;
    for (const k of this.#set) {
      if (k.includes(marker)) return true;
    }
    return false;
  }

  /**
   * Channel-Bildschirm betreten. Wechselt der Channel WIRKLICH (anderer als der
   * zuletzt aktive), werden die Opens des ALTEN Channels verworfen — der HQ-
   * Stream-Keep-Alive-Abgleicher beendet dann dessen Verbindungen. Betritt man
   * denselben Channel erneut (z.B. Rückkehr aus einer DM), passiert NICHTS, die
   * Opens bleiben → die im Hintergrund weiterlaufende Verbindung wird sofort
   * wieder angezeigt (kein Reconnect).
   */
  enterChannel(channelId: string): void {
    if (this.#activeChannel !== null && this.#activeChannel !== channelId) {
      this.resetChannel(this.#activeChannel);
    }
    this.#activeChannel = channelId;
  }

  /** Drop all opens for a channel — used on channel switch. */
  resetChannel(channelId: string): void {
    const marker = `::${channelId}::`;
    let changed = false;
    const next = new Set(this.#set);
    for (const k of this.#set) {
      if (k.includes(marker)) {
        next.delete(k);
        changed = true;
      }
    }
    if (changed) this.#set = next;
  }

  /** Drop opens whose id is no longer in the active set for that kind.
   *  Caller passes the current live ids per kind — including the set of live
   *  party_ids (several parties may run in one channel). */
  pruneChannel(
    channelId: string,
    active: { hq?: Set<string>; screen?: Set<string>; cam?: Set<string>; party?: Set<string> }
  ): void {
    const marker = `::${channelId}::`;
    let changed = false;
    const next = new Set(this.#set);
    for (const k of this.#set) {
      const idx = k.indexOf(marker);
      if (idx < 0) continue;
      const kind = k.slice(0, idx) as TileKind;
      const id = k.slice(idx + marker.length);
      let stillLive: boolean;
      if (kind === 'party') stillLive = active.party?.has(id) === true;
      else if (kind === 'hq') stillLive = active.hq?.has(id) === true;
      else if (kind === 'screen') stillLive = active.screen?.has(id) === true;
      else stillLive = active.cam?.has(id) === true;
      if (!stillLive) {
        next.delete(k);
        changed = true;
      }
    }
    if (changed) this.#set = next;
  }
}

export const openedTiles = new OpenedTiles();
