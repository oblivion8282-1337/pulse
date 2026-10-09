/**
 * Per-channel unread tracking.
 *
 * Two pieces of state:
 *  - `lastReadByChannel` — the latest message id the user has acknowledged
 *    for each channel. Persisted to localStorage per-user (`pulse.readState.<uid>`).
 *  - `latestByChannel` — the latest message id we've observed for each channel
 *    in this session, in memory only.
 *
 * A channel is unread when `latest > lastRead`. Snowflake-IDs werden über
 * `compareSnowflakeId` verglichen (vergleicht die eingebettete Zeit, s.
 * `utils/snowflakeZeit.ts`) — ein reiner String- oder Längen-Vergleich bricht
 * sowohl an der Stellen-Grenze (17→18 Ziffern, ~Okt 2026) als auch bei den
 * lokalen 20-stelligen IDs verschlüsselter Nachrichten.
 *
 * Limitation (v1): unread state seeds from activity DURING the session. If a
 * message was posted while the client was offline and never sync-loaded, the
 * channel will not show as unread on next launch. Proper offline catch-up
 * would need a server-side read-state sync — out of scope for now.
 */

import { compareSnowflakeId } from '$lib/utils/snowflake';
import { istGelesenBis, vorwaertsMerge } from '$lib/stores/lesestandKern';
import { quittungen } from '$lib/stores/quittungen.svelte';

const STORAGE_PREFIX = 'pulse.readState.';
const MENTIONS_PREFIX = 'pulse.mentions.';
const UNREAD_PREFIX = 'pulse.unread.';
const UNREAD_BIS_PREFIX = 'pulse.unreadBis.';

class ReadState {
  lastReadByChannel = $state<Record<string, string>>({});
  latestByChannel = $state<Record<string, string>>({});
  // Was die GEGENSEITE meldet (Lese-/Zustellstand fürs Häkchen) lebt seit
  // 2026-10-10 in `quittungen.svelte.ts`; dieser Store hält nur den eigenen
  // Lesestand und die Zähler.
  /** Per-channel unread @-mention counter — bumped by the WS handler
   *  when a `mention_added` event (or an inline `message` whose mentions
   *  include the current user) lands for a channel the user isn't
   *  actively viewing. Cleared by `markRead` and `clearMentions`. */
  mentionCountByChannel = $state<Record<string, number>>({});
  /** Per-channel unread MESSAGE counter — bumped by the WS handler for every
   *  message (channel_bump / dm_bump) that lands for a channel the user isn't
   *  actively viewing. Superset of `mentionCountByChannel` (a mention also
   *  bumps this). Drives the red count pill everywhere. Cleared by `markRead`. */
  unreadCountByChannel = $state<Record<string, number>>({});
  /** Bis zu welcher Nachricht der Zähler oben reicht (je Kanal die jüngste
   *  gezählte, kanonische ID). Erst damit kann ein eigener Lesestand von
   *  einem ANDEREN Gerät den Zähler löschen (`seedOwnLesestand`): ohne zu
   *  wissen, was gezählt wurde, wäre „dort bis X gelesen" keine Aussage über
   *  die hier gezählten Nachrichten. Fehlt der Eintrag (Zähler von vor
   *  2026-10-10), bleibt der Zähler stehen, bis man den Kanal hier öffnet. */
  unreadBisByChannel = $state<Record<string, string>>({});

  private storageKey = '';
  private mentionsKey = '';
  private unreadKey = '';
  private unreadBisKey = '';
  /** Ausstehende entprellte Schreibvorgänge je Schlüssel. Die Karte wird
   *  erst beim Auslösen gelesen — ein Flush/Reset schreibt also den dann
   *  aktuellen Stand, nicht einen Schnappschuss von der Planung. */
  private wecker = new Map<
    string,
    { timer: ReturnType<typeof setTimeout>; karte: () => Record<string, unknown> }
  >();

  constructor() {
    // Derselbe Schutz wie im Drafts-Store (Bughunt Runde 3): das 200-ms-
    // Debounce-Fenster darf einen Reload nicht überleben — sonst springt
    // der Lesestand der letzten Nachricht beim F5 auf ungelesen zurück.
    if (typeof window !== 'undefined') {
      window.addEventListener('pagehide', () => this.flushPending());
    }
  }

  /** Liest eine der drei Karten aus dem Speicher. `null` heisst „da steht
   *  nichts Brauchbares" — der Aufrufer behält dann seinen bisherigen Stand.
   *  `null` ist bewusst von `{}` unterschieden: ein leeres Objekt wäre von
   *  „wirklich nichts gelesen" nicht zu trennen. */
  private ladeKarte<T>(key: string): Record<string, T> | null {
    if (!key || typeof window === 'undefined') return null;
    try {
      const raw = window.localStorage.getItem(key);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') return parsed as Record<string, T>;
    } catch {
      // Corrupt localStorage — start fresh.
    }
    return null;
  }

  hydrateForUser(userId: string): void {
    this.storageKey = `${STORAGE_PREFIX}${userId}`;
    this.mentionsKey = `${MENTIONS_PREFIX}${userId}`;
    this.unreadKey = `${UNREAD_PREFIX}${userId}`;
    this.unreadBisKey = `${UNREAD_BIS_PREFIX}${userId}`;
    if (typeof window === 'undefined') return;
    this.lastReadByChannel = this.ladeKarte<string>(this.storageKey) ?? this.lastReadByChannel;
    this.mentionCountByChannel =
      this.ladeKarte<number>(this.mentionsKey) ?? this.mentionCountByChannel;
    this.unreadCountByChannel =
      this.ladeKarte<number>(this.unreadKey) ?? this.unreadCountByChannel;
    this.unreadBisByChannel =
      this.ladeKarte<string>(this.unreadBisKey) ?? this.unreadBisByChannel;
  }

  clear(): void {
    this.flushPending();
    this.storageKey = '';
    this.mentionsKey = '';
    this.unreadKey = '';
    this.unreadBisKey = '';
    this.lastReadByChannel = {};
    this.latestByChannel = {};
    quittungen.clear();
    this.mentionCountByChannel = {};
    this.unreadCountByChannel = {};
    this.unreadBisByChannel = {};
  }

  /**
   * Phase 4.5: Reset-on-Server-Switch.
   *
   * Im Gegensatz zu `clear()` bleibt der localStorage-Inhalt erhalten —
   * die Persistenz ist `pulse.readState.<userId>`-keyed, **nicht**
   * server-keyed. Wir leeren nur die Sitzungsbeobachtung, sodass der
   * neue Server-Connection-ready-Frame mit den eigenen Channels seeden
   * kann. `storageKey`/`mentionsKey` bleiben gesetzt, damit `markRead`
   * weiterhin in den User-Key persistiert.
   *
   * Bughunt 2026-08-17: dabei durfte der Speicher nicht aus einer LEEREN
   * Karte heraus fortgeschrieben werden. Die Schlüssel hängen am Konto, nicht
   * am Server — ein `markRead` nach dem Wechsel hätte den Lesestand aller
   * Server (samt Direktnachrichten) auf die paar Kanäle des neuen Servers
   * eingedampft, und ein noch laufender Schreib-Wecker hätte schlicht `{}`
   * hineingeschrieben. Deshalb: ausstehende Schreibvorgänge zuerst ausführen,
   * dann den persistierten Stand neu einlesen. In-Memory bleibt damit immer
   * das vollständige Kontobild — derselbe Zustand wie nach einem Neuladen der
   * Seite. Nur `latestByChannel` wird wirklich geleert; das ist der einzige
   * Teil, der pro Sitzung neu beobachtet wird (und nie persistiert).
   */
  resetCacheOnly(): void {
    this.flushPending();
    this.latestByChannel = {};
    this.lastReadByChannel = this.ladeKarte<string>(this.storageKey) ?? {};
    // Die Stände der Gegenseite sind sessionseitig vom Server geliefert —
    // der neue ready-Rahmen füllt sie nach (gleiches Bild wie nach einem
    // Reload). Leeren, sonst überleben sie den Server-Wechsel (Befund 06.10.).
    quittungen.clear();
    this.mentionCountByChannel = this.ladeKarte<number>(this.mentionsKey) ?? {};
    this.unreadCountByChannel = this.ladeKarte<number>(this.unreadKey) ?? {};
    this.unreadBisByChannel = this.ladeKarte<string>(this.unreadBisKey) ?? {};
  }

  /** Führt die drei entprellten Schreibvorgänge sofort aus und entschärft die
   *  Wecker. Ohne das feuert ein Wecker nach einem Reset/Sign-out und schreibt
   *  den bereits verworfenen Stand unter die weiterhin gültigen Schlüssel. */
  flushPending(): void {
    for (const [key, wecker] of this.wecker) {
      clearTimeout(wecker.timer);
      this.wecker.delete(key);
      this.write(key, wecker.karte());
    }
  }

  /** Kopie der Karte ohne den Kanal-Eintrag — für die Forget-Blöcke in
   *  `forgetChannel` (die Wächter dort bleiben stehen, damit ohne Treffer
   *  keine Zuweisung und damit keine Reaktivität feuert). */
  private ohneKanal<T>(karte: Record<string, T>, channelId: string): Record<string, T> {
    const next = { ...karte };
    delete next[channelId];
    return next;
  }

  /** Drop all read-state for a deleted channel so its keys don't linger in
   *  memory or in the persisted localStorage blobs. */
  forgetChannel(channelId: string): void {
    if (channelId in this.lastReadByChannel) {
      this.lastReadByChannel = this.ohneKanal(this.lastReadByChannel, channelId);
      this.persistLetztenStand();
    }
    if (channelId in this.latestByChannel) {
      this.latestByChannel = this.ohneKanal(this.latestByChannel, channelId);
    }
    // Auch die Häkchen-Stände leeren (Befund 06.10.) — sonst bleiben tote
    // Kanal-/Gruppen-Schlüssel für die Session liegen.
    quittungen.kanalVergessen(channelId);
    this.clearMentions(channelId);
    this.clearUnread(channelId);
  }

  /** Record that we've observed a message in this channel (from any source —
   *  WS message frame, channel_bump envelope, or an initial-load fetch). */
  recordSeen(channelId: string, messageId: string): void {
    const prev = this.latestByChannel[channelId];
    if (!prev || compareSnowflakeId(messageId, prev) > 0) {
      this.latestByChannel = { ...this.latestByChannel, [channelId]: messageId };
    }
  }

  /** Acknowledge the channel up to (and including) `messageId`. Falls back
   *  to the latest-seen id if none is provided. Persists immediately.
   *  Also clears any pending mention count for the channel — opening a
   *  channel mark-reads it, so the @-badge goes away in lockstep.
   *  P0.2: der Fortschritt geht zusätzlich entprellt an den Server
   *  (`serverSync`-Haken, installiert von `api/lesestand.ts`) — dort ist
   *  die geräteübergreifende Wahrheit. */
  markRead(channelId: string, messageId?: string): void {
    const target = messageId ?? this.latestByChannel[channelId];
    if (!target) {
      // No new message id but we still want the badges to clear on focus
      // (e.g. when the user clicks an empty channel).
      this.clearMentions(channelId);
      this.clearUnread(channelId);
      return;
    }
    const prev = this.lastReadByChannel[channelId];
    if (!prev || compareSnowflakeId(target, prev) > 0) {
      this.lastReadByChannel = { ...this.lastReadByChannel, [channelId]: target };
      this.persistLetztenStand();
      this.serverSync?.(channelId, target);
    }
    this.clearMentions(channelId);
    this.clearUnread(channelId);
  }

  /** Hook für den Server-Reporter (`api/lesestand.ts`); null = nur lokal. */
  private serverSync: ((channelId: string, messageId: string) => void) | null = null;
  setServerSync(fn: (channelId: string, messageId: string) => void): void {
    this.serverSync = fn;
  }

  /** Mergt den EIGENEN Server-Stand in den lokalen — nur vorwärts. Ein
   *  frisch geladener Tab (oder das zweite Gerät) übernimmt den größeren
   *  Stand, ohne jemals einen neueren lokalen zu verlieren.
   *
   *  Reicht der Stand bis zur jüngsten hier GEZÄHLTEN Nachricht, fällt auch
   *  der Zähler (Befund 2026-10-10): wer am Handy liest, sah am Rechner bis
   *  dahin den Fettdruck verschwinden, die rote Zahl aber stehen bleiben. */
  seedOwnLesestand(channelId: string, messageId: string): void {
    this.lastReadByChannel = {
      ...this.lastReadByChannel,
      [channelId]: vorwaertsMerge(this.lastReadByChannel[channelId], messageId)
    };
    const gezaehltBis = this.unreadBisByChannel[channelId];
    if (gezaehltBis && istGelesenBis(messageId, gezaehltBis) === true) {
      this.clearMentions(channelId);
      this.clearUnread(channelId);
    }
  }

  isUnread(channelId: string): boolean {
    const latest = this.latestByChannel[channelId];
    if (!latest) return false;
    const lastRead = this.lastReadByChannel[channelId];
    return !lastRead || compareSnowflakeId(latest, lastRead) > 0;
  }

  /** Bump the per-channel @-mention counter by one. */
  incMention(channelId: string): void {
    const prev = this.mentionCountByChannel[channelId] ?? 0;
    this.mentionCountByChannel = {
      ...this.mentionCountByChannel,
      [channelId]: prev + 1
    };
    this.persistMentions();
  }

  /** Zero the counter for a channel — called from `markRead` and on
   *  explicit "I've read this" actions. */
  clearMentions(channelId: string): void {
    if (!this.mentionCountByChannel[channelId]) return;
    const next = { ...this.mentionCountByChannel };
    delete next[channelId];
    this.mentionCountByChannel = next;
    this.persistMentions();
  }

  /** Bump the per-channel unread-message counter by one. `anker` = die
   *  kanonische ID der gezählten Nachricht (s. `unreadBisByChannel`). */
  incUnread(channelId: string, anker?: string): void {
    const prev = this.unreadCountByChannel[channelId] ?? 0;
    this.unreadCountByChannel = {
      ...this.unreadCountByChannel,
      [channelId]: prev + 1
    };
    this.persistUnread();
    if (anker) {
      this.unreadBisByChannel = {
        ...this.unreadBisByChannel,
        [channelId]: vorwaertsMerge(this.unreadBisByChannel[channelId], anker)
      };
      this.persist(this.unreadBisKey, () => this.unreadBisByChannel);
    }
  }

  /** Zero the unread-message counter for a channel — called from `markRead`. */
  clearUnread(channelId: string): void {
    if (channelId in this.unreadBisByChannel) {
      this.unreadBisByChannel = this.ohneKanal(this.unreadBisByChannel, channelId);
      this.persist(this.unreadBisKey, () => this.unreadBisByChannel);
    }
    if (!this.unreadCountByChannel[channelId]) return;
    const next = { ...this.unreadCountByChannel };
    delete next[channelId];
    this.unreadCountByChannel = next;
    this.persistUnread();
  }

  /** Synchronous lookup; 0 when nothing unread. */
  getUnreadCount(channelId: string): number {
    return this.unreadCountByChannel[channelId] ?? 0;
  }

  /** Sum of unread-message counts across the given channels. Drives the
   *  guild-rail / home count pills. O(n) per call — fine for these sizes. */
  sumUnread(channelIds: readonly string[]): number {
    let total = 0;
    for (const cid of channelIds) total += this.unreadCountByChannel[cid] ?? 0;
    return total;
  }

  /** Einziger Schreibpunkt in den Speicher. Quota exceeded / abgeschaltet —
   *  stillschweigend verwerfen; der In-Memory-Stand bleibt korrekt. */
  private write(key: string, karte: Record<string, unknown>): void {
    if (!key || typeof window === 'undefined') return;
    try {
      window.localStorage.setItem(key, JSON.stringify(karte));
    } catch {
      // Quota exceeded / disabled — silently drop.
    }
  }

  /** Plan für `key` einen 200-ms-Entprellt-Schreibvorgang (neu). */
  private persist(key: string, karte: () => Record<string, unknown>): void {
    if (!key || typeof window === 'undefined') return;
    const alt = this.wecker.get(key);
    if (alt) clearTimeout(alt.timer);
    this.wecker.set(key, {
      karte,
      timer: setTimeout(() => {
        this.wecker.delete(key);
        this.write(key, karte());
      }, 200)
    });
  }

  private persistLetztenStand(): void {
    this.persist(this.storageKey, () => this.lastReadByChannel);
  }

  private persistMentions(): void {
    this.persist(this.mentionsKey, () => this.mentionCountByChannel);
  }

  private persistUnread(): void {
    this.persist(this.unreadKey, () => this.unreadCountByChannel);
  }
}

export const readState = new ReadState();
