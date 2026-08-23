/**
 * Das Ziehen in der Kanalliste — Zustand und Verhalten an einer Stelle.
 *
 * **Warum ausgelagert:** `ChannelList.svelte` war auf 819 Zeilen gewachsen
 * (harte Grenze 500, `PLAN.md` §12.1) und wird seit dem Mobil-Umbau an drei
 * Stellen gebraucht: als Vollbild-Liste, im Kanal-Wechsler-Sheet und als
 * Tablet-Spalte. Beim Aufteilen in Abschnitte war das Ziehen der einzige
 * Brocken, den ALLE Abschnitte teilen — Text, Ablage und Sprache reihen
 * gleichermassen um, und nur Sprachkanäle nehmen zusätzlich Nutzer und Geräte
 * entgegen. Läge es in den Abschnitten, stünde es dreimal da.
 *
 * **Zwei Nutzlasten auf einer Geste.** Eine eigene MIME-Kennung
 * (`voice/userDrag.ts`, `devices/geraetZug.ts`) trennt „Nutzer verschieben"
 * und „Gerät umstellen" vom blossen Umsortieren; die Hervorhebung ist
 * bewusst dieselbe, denn für den Ziehenden ist es dieselbe Geste. Getrennt
 * sind nur die Nutzlasten, damit das Ablegen weiss, was es in der Hand hält.
 */
import { toast } from 'svelte-sonner';
import { moveIntoVoiceChannel } from '$lib/api/voice';
import { carriesUser, droppedUserId } from '$lib/voice/userDrag';
import { traegtGeraet, gezogenesGeraet } from '$lib/devices/geraetZug';
import { geraeteUmzug } from '$lib/devices/umzug.svelte';
import { userCache } from '$lib/stores/users.svelte';
import { reorderChannel } from '$lib/channels/reorder';
import type { Channel, Guild } from '$lib/api/types';
import { m } from '$lib/paraglide/messages.js';

/**
 * Was das Ablegen wissen muss, um zu entscheiden, wohin ein Kanal rutscht.
 * Wird bei jedem Aufruf durchgereicht statt im Zustand gehalten — die Listen
 * sind abgeleitete Werte, ein gemerkter Verweis wäre beim Ablegen veraltet.
 */
export interface ZiehKontext {
  guild: Guild | null;
  channels: Channel[];
  textChannels: Channel[];
  voiceChannels: Channel[];
  /** Eigene Nutzerkennung — wer sich selbst zieht, wechselt nur den Kanal. */
  myId: string | null;
  /** Derselbe Weg wie ein Klick auf die Zeile (verbindet bei Sprachkanälen). */
  auswaehlen: (c: Channel) => void;
}

/** Der laufende Zug. Eine Instanz je Liste. */
export class KanalZiehen {
  /** Kanal, der gerade gezogen wird (blasst seine Zeile ab). */
  id = $state<string | null>(null);
  /** Kanal, über dem der Zeiger steht (bekommt die Einfüge-Linie). */
  ueber = $state<string | null>(null);
  /** Sprachkanal, über dem ein Nutzer oder Gerät schwebt (Ablege-Fläche). */
  nutzerUeber = $state<string | null>(null);

  zuruecksetzen(): void {
    this.id = null;
    this.ueber = null;
    this.nutzerUeber = null;
  }
}

export function beginnen(
  e: DragEvent,
  c: Channel,
  z: KanalZiehen,
  darfVerwalten: boolean
): void {
  if (!darfVerwalten || !e.dataTransfer) return;
  z.id = c.id;
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', c.id);
}

export function darueber(e: DragEvent, c: Channel, z: KanalZiehen, channels: Channel[]): void {
  if (!z.id || z.id === c.id) return;
  const src = channels.find((x) => x.id === z.id);
  if (!src || src.type !== c.type) return; // nur innerhalb derselben Gruppe
  e.preventDefault();
  z.ueber = c.id;
}

export function beenden(z: KanalZiehen): void {
  z.zuruecksetzen();
}

export async function ablegen(
  e: DragEvent,
  ziel: Channel,
  z: KanalZiehen,
  ctx: ZiehKontext
): Promise<void> {
  e.preventDefault();
  const quelle = z.id;
  z.id = null;
  z.ueber = null;
  if (!quelle || !ctx.guild) return;
  const src = ctx.channels.find((x) => x.id === quelle);
  // Nur innerhalb derselben Kanalart umsortieren — die Reihenfolge ist je
  // Gruppe gezählt, ein Sprachkanal zwischen Textkanälen hätte keine Stelle.
  if (!src || src.type !== ziel.type) return;
  const gruppe = src.type === 1 ? ctx.voiceChannels : ctx.textChannels;
  try {
    await reorderChannel(gruppe, quelle, ziel.id, ctx.guild.id);
  } catch (err) {
    toast.error(m.channel_list_reorder_failed(), {
      description: (err as Error).message
    });
  }
}

export function sprachDarueber(
  e: DragEvent,
  c: Channel,
  z: KanalZiehen,
  ctx: ZiehKontext
): void {
  // `carriesUser`/`traegtGeraet` haben `dataTransfer` bereits als vorhanden
  // nachgewiesen.
  if (carriesUser(e) || traegtGeraet(e)) {
    e.preventDefault();
    e.dataTransfer!.dropEffect = 'move';
    z.nutzerUeber = c.id;
    return;
  }
  darueber(e, c, z, ctx.channels);
}

export function sprachVerlassen(e: DragEvent, c: Channel, z: KanalZiehen): void {
  // Nur räumen, wenn der Zeiger die Zeile wirklich verlässt — `dragleave`
  // feuert auch beim Eintritt in ein Kindelement.
  if (
    z.nutzerUeber === c.id &&
    !(e.currentTarget as Element | null)?.contains(e.relatedTarget as Node | null)
  ) {
    z.nutzerUeber = null;
  }
}

export async function sprachAblegen(
  e: DragEvent,
  c: Channel,
  z: KanalZiehen,
  ctx: ZiehKontext
): Promise<void> {
  // Gerät zuerst: die Prüfung ist ein Blick in die Nutzlast, und der Rest der
  // Funktion gehört dem Nutzer-Fall. Ob umgestellt oder nur nachgefragt wird,
  // entscheidet `umzug.svelte.ts` — hier endet der Weg der Kanalliste.
  const geraetId = gezogenesGeraet(e);
  if (geraetId) {
    e.preventDefault();
    z.nutzerUeber = null;
    geraeteUmzug.anfordern(ctx.guild?.id, geraetId, c);
    return;
  }
  const uid = droppedUserId(e);
  if (!uid) {
    await ablegen(e, c, z, ctx); // keine Nutzer-Nutzlast → Umsortieren
    return;
  }
  e.preventDefault();
  z.nutzerUeber = null;
  if (uid === ctx.myId) {
    // Sich selbst ziehen = in den Kanal wechseln, wie ein Klick.
    ctx.auswaehlen(c);
    return;
  }
  try {
    await moveIntoVoiceChannel(c.id, uid);
    toast.success(m.popover_actions_voice_moved({ displayName: userCache.displayName(uid) }));
  } catch (err) {
    toast.error(m.popover_actions_voice_move_failed(), {
      description: err instanceof Error ? err.message : String(err)
    });
  }
}
