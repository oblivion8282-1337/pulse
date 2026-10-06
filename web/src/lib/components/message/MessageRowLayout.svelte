<script lang="ts">
  /**
   * Die klassische Zeilen-Hülle einer Nachricht: Avatar links, darüber Name
   * und Uhrzeit, Fortsetzungen ohne beides.
   *
   * Aus `MessageItem.svelte` herausgelöst, als die privaten Nachrichten eine
   * zweite Hülle bekamen (Sprechblasen, Mobil-Umbau 2026-08-22). **Nur die
   * Hülle wandert** — Inhalt, Bearbeiten, Anhänge, Reaktionen, Melden und das
   * Aktionsblatt bleiben in `MessageItem` und werden als Schnipsel
   * hereingereicht. Eine eigene Sprechblasen-Komponente hätte all das
   * stillschweigend verloren.
   *
   * Markup unverändert übernommen, `data-testid` identisch.
   */
  import type { Snippet } from 'svelte';
  import { anfangsBuchstabe } from '$lib/utils/anfangsBuchstabe';
  import * as Avatar from '$lib/components/ui/avatar/index.js';
  import UserProfilePopover from '$lib/components/UserProfilePopover.svelte';
  import { longpress } from '$lib/utils/longpress';
  import type { Message } from '$lib/api/types';
  import PinIcon from '@lucide/svelte/icons/pin';
  import { m } from '$lib/paraglide/messages.js';
	import { auth } from '$lib/stores/auth.svelte';

  let {
    message,
    authorName,
    authorStyle = '',
    url,
    time,
    pending = false,
    leseBestaetigt = undefined,
    zugestellt = undefined,
    isContinuation = false,
    highlight = false,
    onLongPress,
    guildId,
    /** Handy-Klasse? Vom Mount-Punkt hereingereicht (Geräte-Trennung) —
     *  schaltet das Profil zwischen Tippen-Blatt und Rechtsklick-Karte. */
    handy,
    body,
    actions
  }: {
    message: Message;
    authorName: string;
    authorStyle?: string;
    url: string | null;
    time: string;
    /** WhatsApp-Treppe (Befund 05.10.): Uhr = nicht zugestellt, einfach
     *  grau = gesendet, doppelt grau = angekommen, doppelt blau = alle
     *  haben gelesen. Nur für eigene Nachrichten in DMs/privaten Gruppen
     *  gesetzt; Community-Kanäle tragen keine Haken. */
    pending?: boolean;
    leseBestaetigt?: boolean;
    zugestellt?: boolean;
    isContinuation?: boolean;
    highlight?: boolean;
    onLongPress: () => void;
    /** Community-Bezug fuer das Profil (Server-Nick, Rollen). Fehlt in DMs. */
    guildId?: string;
    handy: boolean;
    body: Snippet;
    actions: Snippet;
  } = $props();

  /** Angepinnt → dezente Tönung + Nadel neben der Uhrzeit. */
  const pinned = $derived(!!message.pinned_at);
  /** Eigene Nachricht? Bestimmt, ob die Haken-Treppe überhaupt erscheint
   *  (nur der Absender sieht Zustände — WhatsApp-Semantik). */
  const eigen = $derived(message.author_id === auth.user?.id);
</script>

<!--
  EIN Rahmen fuer beide Faelle. Vorher standen hier zwei vollstaendige
  `<div>`-Bloecke nebeneinander, die sich in genau einer Klasse unterschieden
  (`py-0.5` gegen `py-1.5`) und ansonsten wortgleich waren — samt
  `data-testid`, `use:longpress` und beiden `class:ring-*`. Das erzeugte
  Markup ist unveraendert; nur die Fallunterscheidung sitzt jetzt INNEN, wo
  der Unterschied tatsaechlich liegt: Fortsetzungen tragen statt Avatar und
  Namenszeile eine schmale Spalte mit der Uhrzeit, die erst beim Ueberfahren
  erscheint.
-->
<div
  class="group relative mx-2 flex gap-3 rounded-2xl px-3 {isContinuation
    ? 'py-0.5'
    : 'py-1.5'} transition-colors hover:bg-bg-hover {pinned ? 'bg-primary/5' : ''}"
  class:ring-2={highlight}
  class:ring-primary={highlight}
  data-testid="message-item"
  data-message-id={message.id}
  use:longpress={{ onLongPress }}
>
  {#snippet haeckel()}
  {#if eigen && pending}
    <svg viewBox="0 0 12 12" class="text-text-muted inline size-3 align-baseline opacity-70" aria-label={m.message_lesebestaetigung_gesendet()} role="img">
      <circle cx="6" cy="6" r="4.6" fill="none" stroke="currentColor" stroke-width="1.4" />
      <path d="M6 3.4v2.8l1.9 1.3" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
    </svg>
  {:else if eigen && (leseBestaetigt !== undefined || zugestellt !== undefined)}
    <svg
      viewBox="0 0 18 12"
      class="mr-1 inline size-3.5 align-baseline {leseBestaetigt ? 'text-[#53bdeb] opacity-100' : 'text-text-muted opacity-70'}"
      aria-label={leseBestaetigt ? m.message_lesebestaetigung_gelesen() : m.message_lesebestaetigung_gesendet()}
      role="img"
    >
      <path d="M1 6.5 4.5 10 10.5 3" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" />
      {#if leseBestaetigt || zugestellt}
        <path d="M6.9 9 8 10.3 15.4 2.8" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" />
      {/if}
    </svg>
  {/if}
{/snippet}
{#if isContinuation}
    <div class="flex w-10 shrink-0 items-center justify-end gap-1">
      {#if pinned}
        <!-- Auch Fortsetzungen ohne Namenszeile müssen den Pin zeigen. -->
        <PinIcon
          class="text-primary size-3 shrink-0"
          aria-label={m.message_pinned_badge()}
          data-testid="message-pinned-badge"
        />
      {/if}
      <span class="text-text-muted hidden text-2xs group-hover:block pointer-coarse:block">{time}</span>
      {@render haeckel()}
    </div>
    <div class="min-w-0 flex-1">
      {@render body()}
    </div>
  {:else}
    <!-- Avatar und Name oeffnen das Profil (Entwurf 11a nennt den
         Nachrichtenautor ausdruecklich). Vorher fuehrte hier gar nichts hin —
         auch am Rechner nicht; das Profil war nur ueber die Mitgliederliste
         erreichbar, die es auf dem Handy nicht gibt. -->
    <UserProfilePopover
      userId={message.author_id}
      displayName={authorName}
      avatarUrl={url}
      {guildId}
      {handy}
    >
      {#snippet children({ props })}
        {#key url}
          <button {...props} class="shrink-0 self-start" data-testid="message-avatar">
            <Avatar.Root class="size-10 shrink-0">
              {#if url}
                <Avatar.Image src={url} alt={authorName} />
              {/if}
              <Avatar.Fallback
                class="accent-gradient text-primary-foreground text-sm font-semibold"
              >
                {anfangsBuchstabe(authorName)}
              </Avatar.Fallback>
            </Avatar.Root>
          </button>
        {/key}
      {/snippet}
    </UserProfilePopover>
    <div class="min-w-0 flex-1">
      <div class="flex items-baseline gap-2">
        <UserProfilePopover
          userId={message.author_id}
          displayName={authorName}
          avatarUrl={url}
          {guildId}
          {handy}
        >
          {#snippet children({ props })}
            <button
              {...props}
              class="text-text-bright font-semibold"
              style={authorStyle}
              data-testid="message-author">{authorName}</button>
          {/snippet}
        </UserProfilePopover>
        <span class="text-text-muted text-xs">{time}</span>
        {@render haeckel()}
        {#if pinned}
          <PinIcon
            class="text-primary size-3 shrink-0"
            aria-label={m.message_pinned_badge()}
            data-testid="message-pinned-badge"
          />
        {/if}
      </div>
      {@render body()}
    </div>
  {/if}
  {@render actions()}
</div>
