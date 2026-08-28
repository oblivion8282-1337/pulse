import { chatApi } from '$lib/api/chat';
import type { DMChannel } from '$lib/api/types';
import { blocks } from './blocks.svelte';
import { compareSnowflakeId } from '$lib/utils/snowflake';
import { verlaufLesenSaetze } from '$lib/verlauf/db';
import { verlaufZustand } from '$lib/verlauf/zustand.svelte';
import {
  mitLokalerVorschauMergen,
  vorschauAusNachricht,
  type LokalerLetzterSatz
} from '$lib/verlauf/vorschauMerge';

/**
 * Holds the caller's 1:1 DM channels. Mirrors `guilds.svelte.ts` in shape:
 * `byId` keyed by snowflake id, sorted `list` derived from it.
 *
 * Hydrated on app boot AND seeded again from `ready.dm_channels` on every
 * WS reconnect. `upsertFromBump` is called from the `dm_bump` WS handler so
 * a fresh DM (or one we created from another device) shows up live without
 * a full hydrate round-trip.
 */
class DirectMessageStore {
  byId = $state<Record<string, DMChannel>>({});
  loaded = $state(false);

  // Most-recently-active first. DMs mit letzter Nachricht oben (neueste
  // zuerst); DMs ohne Nachricht (last_message_id null) darunter, nach
  // Erstellung (id) sortiert — eine frische leere DM rutscht so nicht vor
  // aktive Threads.
  list = $derived(
    Object.values(this.byId).sort((a, b) => {
      const aMsg = a.last_message_id;
      const bMsg = b.last_message_id;
      if (aMsg && bMsg) return compareSnowflakeId(bMsg, aMsg);
      if (aMsg) return -1;
      if (bMsg) return 1;
      return compareSnowflakeId(b.id, a.id);
    })
  );

  async hydrate(): Promise<void> {
    const dms = await chatApi.listDMChannels();
    const next: Record<string, DMChannel> = {};
    for (const d of dms) next[d.id] = d;
    this.byId = next;
    this.loaded = true;
    void this.mergeLokaleVorschauen(dms.map((d) => d.id));
  }

  /** Replace the whole map — used when WS `ready` re-seeds the list. */
  seed(dms: DMChannel[]): void {
    const next: Record<string, DMChannel> = {};
    for (const d of dms) next[d.id] = d;
    this.byId = next;
    this.loaded = true;
    void this.mergeLokaleVorschauen(dms.map((d) => d.id));
  }

  /**
   * Etappe C3/C4: der Server kennt eine verschluesselte Nachricht nie — sein
   * `last_message_id`/`last_message_preview` bleibt fuer ein solches
   * Gespraech beim letzten KLARTEXT-Stand stehen (oder `null`, gab es nie
   * einen). `hydrate()`/`seed()` uebernehmen den Server-Wert deshalb erst
   * roh (oben, synchron — unveraendertes Verhalten, sofort sichtbar), dann
   * ergaenzt dieser asynchrone Schritt je Kanal den lokal abgelegten letzten
   * Satz, falls der nachweislich neuer ist (`vorschauMerge.ts`).
   *
   * **Bewusst nach `this.byId[id]` zum Zeitpunkt der ZUWEISUNG gelesen, nicht
   * aus dem `dms`-Schnappschuss von oben:** zwischen dem Start dieser IDB-
   * Lesevorgaenge und ihrem Ende kann ein Live-Ereignis (`upsertFromEncrypted`,
   * `upsertFromBump`) denselben Kanal bereits weiter nach vorn gebracht haben
   * — der Merge darf das nicht zuruecksetzen. Der Lesezugriff auf `this.byId`
   * unten laeuft NACH dem `await`, also ohne weitere Unterbrechung bis zur
   * Zuweisung: kein Ereignis kann dazwischenfunken.
   */
  private async mergeLokaleVorschauen(kanalIds: string[]): Promise<void> {
    const lokale = await Promise.all(
      kanalIds.map(async (id) => [id, await this.letzterLokalerSatz(id)] as const)
    );
    const next = { ...this.byId };
    let geaendert = false;
    for (const [id, lokal] of lokale) {
      if (!lokal) continue;
      const aktuell = next[id];
      if (!aktuell) continue; // Kanal ist seither verschwunden.
      const gemergt = mitLokalerVorschauMergen(aktuell, lokal);
      if (gemergt !== aktuell) {
        next[id] = gemergt;
        geaendert = true;
      }
    }
    if (geaendert) this.byId = next;
  }

  /** Wirft nie — ein Lesefehler faellt auf „kein lokaler Satz" zurueck (der
   *  Server-Wert bleibt dann einfach stehen), meldet sich aber bei
   *  `verlaufZustand` wie die uebrigen Lesepfade in `verlauf/index.ts`.
   *  Direkt gegen `verlauf/db.ts`, nicht gegen `verlauf/index.ts::verlaufLesen`
   *  — dessen `istDmKanal`-Gate wuerde hier immer durchfallen (dieser Kanal
   *  wird ja GERADE erst in `byId` eingetragen), obwohl die ID unzweifelhaft
   *  ein DM-Kanal ist (sie steht in der DM-Liste, die diese Funktion aufruft). */
  private async letzterLokalerSatz(kanalId: string): Promise<LokalerLetzterSatz | null> {
    try {
      const [satz] = await verlaufLesenSaetze(kanalId, { anzahl: 1 });
      if (!satz || satz.geloescht) return null;
      return {
        nachrichtId: satz.nachrichtId,
        autorId: satz.autorId,
        erstelltAm: satz.erstelltAm,
        inhalt: satz.inhalt,
        anhaenge: satz.anhaenge
      };
    } catch (err) {
      verlaufZustand.melde(err);
      return null;
    }
  }

  upsert(dm: DMChannel): void {
    this.byId = { ...this.byId, [dm.id]: dm };
  }

  /**
   * Apply a `dm_bump` envelope. Creates the channel entry if we didn't know
   * about it yet (e.g. the other side just opened a DM with us). Returns
   * `false` if `currentUserId` isn't a member of this DM (caller should
   * ignore the bump in that case).
   */
  upsertFromBump(args: {
    channel_id: string;
    user_a_id: string;
    user_b_id: string;
    message_id: string;
    currentUserId: string;
  }): boolean {
    const { channel_id, user_a_id, user_b_id, message_id, currentUserId } = args;
    if (user_a_id !== currentUserId && user_b_id !== currentUserId) return false;
    const otherUserId = user_a_id === currentUserId ? user_b_id : user_a_id;
    const existing = this.byId[channel_id];
    const next: DMChannel = existing
      ? { ...existing, last_message_id: message_id }
      : {
          id: channel_id,
          other_user_id: otherUserId,
          last_message_id: message_id,
          // We don't know the real created_at here — use "now" as a
          // best-effort. The next hydrate (or ready) will overwrite it.
          created_at: new Date().toISOString(),
          // Derive can_send from the local blocks store when available.
          // If the other user is blocked, the composer must be disabled
          // immediately — before the next ready/hydrate fills the real flag.
          // Only set false when we're certain (blocks.loaded); leave
          // undefined otherwise so the hydrate result takes precedence.
          ...(blocks.loaded && blocks.has(otherUserId) ? { can_send: false } : {}),
        };
    this.byId = { ...this.byId, [channel_id]: next };
    return true;
  }

  /**
   * Bump fuer den verschluesselten Weg (Bughunt 2026-08-28, FIX 3). Anders
   * als `upsertFromBump` gibt es hier KEIN Server-Ereignis mit `user_a_id`/
   * `user_b_id` — der `postfach_neu`-Weckruf ist bewusst inhaltslos (Spec
   * §4), und beim Senden weiss der Server nicht einmal, dass dieses Geraet
   * gerade selbst verschickt hat. Aufrufer (`krypto/senden.ts` beim Senden,
   * `ws/handlers/chat.ts` beim Empfangen) kennen die Gegenstelle bereits aus
   * dem entschluesselten Kontext und uebergeben sie direkt, statt sie aus
   * einem Ereignis herzuleiten.
   *
   * **Etappe C3: traegt seit hier auch die Vorschau.** Anders als beim
   * Klartext-Bump (`upsertFromBump`, dem der Server-Vorschautext fehlt und
   * der deshalb auf ein entprelltes Nachladen angewiesen ist,
   * `ws/handlers/chat.ts::dmVorschauAuffrischen`) liegt der Klartext hier dem
   * Aufrufer bereits vor — verschluesselt entstehen und ankommen heisst hier
   * "gerade entschluesselt/verfasst". Kein Nachladen noetig, kein Umweg ueber
   * `mergeLokaleVorschauen` (der greift ohnehin erst beim naechsten
   * hydrate/seed, also nach einem Neustart/Reconnect).
   */
  upsertFromEncrypted(args: {
    channel_id: string;
    message_id: string;
    otherUserId: string;
    inhalt: string;
    autorId: string;
    erstelltAm: string;
    anhaenge?: unknown[];
  }): void {
    const { channel_id, message_id, otherUserId, inhalt, autorId, erstelltAm, anhaenge } = args;
    const vorschau = vorschauAusNachricht(inhalt, anhaenge ?? []);
    const existing = this.byId[channel_id];
    const next: DMChannel = existing
      ? {
          ...existing,
          last_message_id: message_id,
          last_message_preview: vorschau,
          last_message_author_id: autorId,
          last_message_at: erstelltAm
        }
      : {
          id: channel_id,
          other_user_id: otherUserId,
          last_message_id: message_id,
          last_message_preview: vorschau,
          last_message_author_id: autorId,
          last_message_at: erstelltAm,
          // Wie bei `upsertFromBump`: die echte `created_at` (des KANALS,
          // nicht der Nachricht) kennen wir hier nicht — der naechste
          // hydrate/ready ueberschreibt sie.
          created_at: new Date().toISOString(),
          ...(blocks.loaded && blocks.has(otherUserId) ? { can_send: false } : {}),
        };
    this.byId = { ...this.byId, [channel_id]: next };
  }

  clear(): void {
    this.byId = {};
    this.loaded = false;
  }
}

export const directMessages = new DirectMessageStore();
