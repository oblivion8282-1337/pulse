<script lang="ts">
  /**
   * Die Sprechblasen-Hülle: eigene Nachrichten rechts im Akzent-Verlauf,
   * fremde links auf der Eingabefeld-Fläche.
   *
   * **Nur für private Gespräche.** In einem Community-Kanal reden mehrere
   * durcheinander, dort tragen Autorname und -farbe die Orientierung — Blasen
   * würden dort schaden. Wer den Bildschirm wechselt, wechselt deshalb die
   * Hülle, nicht den Inhalt: Bearbeiten, Anhänge, Reaktionen, Melden und das
   * Aktionsblatt kommen unverändert aus `MessageItem` herein.
   *
   * Kein Avatar in der Unterhaltung — mit wem man schreibt, steht im Kopf des
   * Bildschirms. Die Uhrzeit steht nur am Ende einer Gruppe, sonst stünde
   * unter jeder einzelnen Zeile eine.
   *
   * Ecken nach dem Entwurf: aussen 20 px, an der Sprech-Seite innerhalb einer
   * Gruppe 7 px — dadurch liest sich eine Gruppe als ein Block statt als
   * Kette einzelner Kissen.
   */
  import type { Snippet } from 'svelte';
  import { longpress } from '$lib/utils/longpress';
  import type { Message } from '$lib/api/types';

  let {
    message,
    time,
    eigen,
    isContinuation = false,
    isGroupEnd = true,
    highlight = false,
    onLongPress,
    body,
    actions
  }: {
    message: Message;
    time: string;
    /** Vom angemeldeten Nutzer selbst — bestimmt Seite und Farbe. */
    eigen: boolean;
    isContinuation?: boolean;
    isGroupEnd?: boolean;
    highlight?: boolean;
    onLongPress: () => void;
    body: Snippet;
    actions: Snippet;
  } = $props();

  // Die Ecke an der Sprech-Seite wird innerhalb einer Gruppe flach. Oben
  // richtet sie sich danach, ob eine Nachricht desselben Absenders darüber
  // steht, unten danach, ob eine darunter folgt.
  let ecken = $derived(
    eigen
      ? `border-radius: 20px ${isContinuation ? '7px' : '20px'} ${isGroupEnd ? '20px' : '7px'} 20px;`
      : `border-radius: ${isContinuation ? '7px' : '20px'} 20px 20px ${isGroupEnd ? '20px' : '7px'};`
  );
</script>

<div
  class="group relative flex px-3 {isContinuation ? 'pt-0.5' : 'pt-2'} {eigen
    ? 'justify-end'
    : 'justify-start'}"
  data-testid="message-item"
  data-message-id={message.id}
  data-eigen={eigen}
  use:longpress={{ onLongPress }}
>
  <div class="flex max-w-[78%] min-w-0 flex-col {eigen ? 'items-end' : 'items-start'}">
    <div
      class="min-w-0 px-3 py-2 {eigen
        ? 'accent-gradient text-white'
        : 'bg-bg-input text-text-base'}"
      class:ring-2={highlight}
      class:ring-primary={highlight}
      style={ecken}
      data-testid="dm-bubble"
    >
      {@render body()}
    </div>
    {#if isGroupEnd}
      <span class="text-text-muted px-1 pt-0.5 text-2xs">{time}</span>
    {/if}
  </div>
  {@render actions()}
</div>
