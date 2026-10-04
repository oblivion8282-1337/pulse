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
   * Bildschirms.
   *
   * **Die Uhrzeit sitzt IN der Blase** (Entwurf 7a), unten an ihrer Kante,
   * und nur am Ende einer Gruppe. Zuerst stand sie darunter — bei einem
   * Gespräch, in dem sich zwei abwechseln, ist aber jede Nachricht ihre
   * eigene Gruppe, und es standen vier Zeitzeilen zwischen vier Sätzen. Der
   * Blick blieb an den Zahlen hängen statt am Text.
   *
   * Ecken nach dem Entwurf: aussen 20 px, an der Sprech-Seite innerhalb einer
   * Gruppe 7 px — dadurch liest sich eine Gruppe als ein Block statt als
   * Kette einzelner Kissen.
   */
  import type { Snippet } from 'svelte';
  import { longpress } from '$lib/utils/longpress';
  import { swipetoreply } from '$lib/utils/swipetoreply';
  import { pfeilDeckkraft } from '$lib/utils/swipeKern';
  import CornerDownRightIcon from '@lucide/svelte/icons/corner-down-right';
  import type { Message } from '$lib/api/types';
  import PinIcon from '@lucide/svelte/icons/pin';
  import { m } from '$lib/paraglide/messages.js';

  let {
    message,
    time,
    eigen,
    pending = false,
    leseBestaetigt = undefined,
    zugestellt = undefined,
    isContinuation = false,
    isGroupEnd = true,
    highlight = false,
    onLongPress,
    onSwipeReply,
    body,
    actions
  }: {
    message: Message;
    time: string;
    /** Vom angemeldeten Nutzer selbst — bestimmt Seite und Farbe. */
    eigen: boolean;
    /** Lesebestätigung für EIGENE DM-Nachrichten (P0.2): `false` = nur
     *  gesendet (einfaches Häkchen), `true` = von der Gegenstelle gelesen
     *  (doppeltes), `undefined` = keine Auskunft (Fremdnachricht, ältere
     *  Gegenstelle) → gar kein Häkchen. */
    leseBestaetigt?: boolean;
    /** Noch nicht zugestellt (optimistische Kopie): Uhr statt Häkchen
     *  (WhatsApp-„Treppe", Befund 05.10.). */
    pending?: boolean;
    /** Angekommen bei allen Empfängern (doppelter GRAUER Haken) — Gruppen
     *  und DMs; solange der blaue (gelesen) noch nicht z greift. */
    zugestellt?: boolean;
    isContinuation?: boolean;
    isGroupEnd?: boolean;
    highlight?: boolean;
    onLongPress: (e: PointerEvent) => void;
    /** Swipe-to-reply (P1.6, nur Touch): löst die Antwort auf diese Nachricht aus. */
    onSwipeReply: () => void;
    body: Snippet;
    actions: Snippet;
  } = $props();

  /** Live-Versatz der Blase (px) — steuert die Pfeil-Deckkraft beim Zug. */
  let swipeOffset = $state(0);

  /** Angepinnt → Nadel neben der Uhrzeit, Blase bekommt einen Hauch Ton. */
  const pinned = $derived(!!message.pinned_at);

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
  <!-- Antwort-Pfeil der Swipe-Geste: an der Zug-Gegenseite, Deckkraft aus
       dem Live-Versatz. `eigen`-Blasen ziehen nach links (Pfeil rechts),
       fremde nach rechts (Pfeil links). -->
  {#if swipeOffset !== 0}
    <span
      class="text-primary absolute inset-y-0 flex items-center {eigen
        ? 'right-4'
        : 'left-4'}"
      style="opacity: {pfeilDeckkraft(swipeOffset)}"
      aria-hidden="true"
    >
      <CornerDownRightIcon class="size-5" />
    </span>
  {/if}
  <div
    class="flex max-w-[78%] min-w-0 flex-col {eigen ? 'items-end' : 'items-start'}"
    style="touch-action: pan-y"
    use:swipetoreply={{ onReply: onSwipeReply, onMove: (o) => (swipeOffset = o) }}
  >
    <div
      class="min-w-0 px-3 py-2 {eigen
        ? 'accent-gradient-deep text-white'
        : 'bg-bg-input text-text-base'} {pinned ? 'ring-1 ring-primary/40' : ''}"
      class:ring-2={highlight}
      class:ring-primary={highlight}
      style={ecken}
      data-testid="dm-bubble"
    >
      {@render body()}
      {#if isGroupEnd}
        <!-- Rechtsbündig unter dem Text, in der Blase. Beim eigenen Verlauf
             gedämpftes Weiss statt der Grauton-Variable — auf Blau wäre Grau
             nicht lesbar. -->
        <span
          class="mt-0.5 block text-right text-2xs leading-none {eigen
            ? 'text-white/70'
            : 'text-text-muted'}"
        >
          {#if pinned}
            <PinIcon
              class="text-primary mr-1 inline size-3 align-baseline"
              aria-label={m.message_pinned_badge()}
              data-testid="message-pinned-badge"
            />
          {/if}
          {#if eigen && pending}
            <!-- Noch nicht zugestellt (optimistisch gesendet): Uhr, grau. -->
            <svg
              viewBox="0 0 12 12"
              class="mr-1 inline size-3 align-baseline opacity-70"
              aria-label={m.message_lesebestaetigung_gesendet()}
              role="img"
            >
              <circle cx="6" cy="6" r="4.6" fill="none" stroke="currentColor" stroke-width="1.4" />
              <path d="M6 3.4v2.8l1.9 1.3" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
            </svg>
          {:else if eigen && (leseBestaetigt !== undefined || zugestellt !== undefined)}
            <!-- Häkchen-Treppe (WhatsApp-Semantik): einfach grau = gesendet,
                 doppelt grau = bei allen angekommen, doppelt BLAU = gelesen.
                 Die blaue Fassung darf die Zeilenfarbe brechen — das Blau
                 ist genau das Signal (Befund 05.10.). -->
            <svg
              viewBox="0 0 18 12"
              class="mr-1 inline size-3.5 align-baseline {leseBestaetigt
                ? 'text-[#53bdeb] opacity-100'
                : 'opacity-70'}"
              aria-label={leseBestaetigt
                ? m.message_lesebestaetigung_gelesen()
                : m.message_lesebestaetigung_gesendet()}
              role="img"
            >
              <path
                d="M1 6.5 4.5 10 10.5 3"
                fill="none"
                stroke="currentColor"
                stroke-width="1.7"
                stroke-linecap="round"
                stroke-linejoin="round"
              />
              {#if leseBestaetigt || zugestellt}
                <path
                  d="M6.9 9 8 10.3 15.4 2.8"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.7"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                />
              {/if}
            </svg>
          {/if}
          {time}</span
        >
      {/if}
    </div>
  </div>
  {@render actions()}
</div>
