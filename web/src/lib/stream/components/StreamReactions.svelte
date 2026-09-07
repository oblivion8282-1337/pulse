<script lang="ts">
  /**
   * Stream-Reactions — Emoji-Schnellwahl + Burst-Overlay auf dem Stream-Tile
   * (IDEAS.md §4 "Stream-Reactions", Twitch-Style).
   *
   * **Fire-and-forget.** Ein Klick schickt
   * `PUT /channels/{id}/stream/reactions/{emoji}/@me` (broadcast-only, keine
   * Speicherung) — gerendert wird NICHT optimistisch: der eigene Burst kommt
   * per WS-Echo zurück, dieselbe Haltung wie die Watch-Party-Reaktionen. Der
   * Burst lebt ausschließlich in dieser Komponente (lokale Liste + Timer,
   * gleiche Bauart wie `StreamChatOverlay`); die Aufwärts-Animation steht in
   * `app.css` (`stream-reaction-float`, mit Reduced-Motion-Deckel).
   *
   * **Rechte.** Serverseitig gilt die Watch-Chat-Leiste (Voice-Channel-Mitglied
   * + VIEW_CHANNEL, geteilter Rate-Limit-Eimer) — Zuschauer ohne
   * Chat-Senderecht dürfen also reagieren. Ein abgewiesener Burst (429/403)
   * ist kein Meldungsfall und bleibt still.
   */
  import { useGatewayListener } from '$lib/ws/useGatewayListener.svelte';
  import { chatApi } from '$lib/api/chat';

  /** `bursten = false` blendet die aufsteigenden Emojis aus — die Schnellwahl
   *  zum Selber-Senden bleibt, und es wird auch nichts mehr gesammelt (der
   *  Kachel-Vorschlag aus dem Test: nicht jeder will das Feuerwerk). */
  let { channelId, bursten = true }: { channelId: string; bursten?: boolean } = $props();

  /** Twitch-konventionelle Schnellwahl — bewusst fix und klein; Custom-Emojis
   *  pro Guild sind ein eigener IDEAS.md-Punkt. */
  const SCHNELLWAHL = ['👍', '❤️', '😂', '😮', '😡', '🔥'] as const;

  let bursts = $state<{ id: number; emoji: string; drift: number; links: number }[]>([]);
  let nextId = 0;

  function burst(emoji: string) {
    const id = nextId++;
    bursts.push({
      id,
      emoji,
      drift: Math.round(Math.random() * 80 - 40),
      links: 5 + Math.random() * 80,
    });
    // Deckel: ein Flood von Reactions darf das Tile nicht volllaufen lassen —
    // aelteste Bursts fallen einfach vorzeitig raus.
    if (bursts.length > 40) bursts.splice(0, bursts.length - 40);
    setTimeout(() => {
      bursts = bursts.filter((b) => b.id !== id);
    }, 2400);
  }

  useGatewayListener((evt) => {
    if (evt.op === 'stream_reaction' && evt.data.channel_id === channelId && bursten) {
      burst(evt.data.emoji);
    }
  });

  function feuern(emoji: string) {
    void chatApi.sendStreamReaction(channelId, emoji).catch(() => {
      /* still — s. Modulkopf */
    });
  }
</script>

{#if bursten}
  <!-- Burst-Ebene: rein dekorativ, keine Zeiger-Events. Die Bursts steigen
       ÜBER der Schnellwahl auf (bottom-24), die Schnellwahl selbst liegt
       bei bottom-14 — IMMER über der Dock-Höhe, denn im Vollbild legt
       TileShell die Steuerleiste als Overlay über den unteren Bildrand
       (TileShell-Kopf: overlay=true) und würde bei bottom-2 überlagert. -->
  <div class="pointer-events-none absolute inset-0 z-10 overflow-hidden">
    {#each bursts as b (b.id)}
      <span
        class="stream-reaction-float absolute bottom-24 text-3xl drop-shadow-md"
        style="left: {b.links}%; --drift: {b.drift}px"
      >
        {b.emoji}
      </span>
    {/each}
  </div>
{/if}

<div
  class="absolute right-2 bottom-14 z-20 flex items-center gap-0.5 rounded-full bg-black/45 px-1.5 py-1 backdrop-blur-sm"
  data-testid="stream-reactions-bar"
>
  {#each SCHNELLWAHL as emoji (emoji)}
    <button
      type="button"
      class="cursor-pointer rounded-full px-1 text-xl leading-none transition-transform hover:scale-125 focus-visible:scale-125 focus-visible:outline-none"
      aria-label={emoji}
      onclick={() => feuern(emoji)}
    >
      {emoji}
    </button>
  {/each}
</div>
