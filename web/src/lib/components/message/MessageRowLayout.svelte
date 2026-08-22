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
  import * as Avatar from '$lib/components/ui/avatar/index.js';
  import UserProfilePopover from '$lib/components/UserProfilePopover.svelte';
  import { longpress } from '$lib/utils/longpress';
  import type { Message } from '$lib/api/types';

  let {
    message,
    authorName,
    authorStyle = '',
    url,
    time,
    isContinuation = false,
    highlight = false,
    onLongPress,
    guildId,
    body,
    actions
  }: {
    message: Message;
    authorName: string;
    authorStyle?: string;
    url: string | null;
    time: string;
    isContinuation?: boolean;
    highlight?: boolean;
    onLongPress: () => void;
    /** Community-Bezug fuer das Profil (Server-Nick, Rollen). Fehlt in DMs. */
    guildId?: string;
    body: Snippet;
    actions: Snippet;
  } = $props();
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
    : 'py-1.5'} transition-colors hover:bg-bg-hover"
  class:ring-2={highlight}
  class:ring-primary={highlight}
  data-testid="message-item"
  data-message-id={message.id}
  use:longpress={{ onLongPress }}
>
  {#if isContinuation}
    <div class="flex w-10 shrink-0 items-center justify-end">
      <span class="text-text-muted hidden text-2xs group-hover:block pointer-coarse:block">{time}</span>
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
    >
      {#snippet children({ props })}
        {#key url}
          <button {...props} class="shrink-0" data-testid="message-avatar">
            <Avatar.Root class="size-10 shrink-0">
              {#if url}
                <Avatar.Image src={url} alt={authorName} />
              {/if}
              <Avatar.Fallback
                class="accent-gradient text-primary-foreground text-sm font-semibold"
              >
                {authorName.slice(0, 1).toUpperCase()}
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
      </div>
      {@render body()}
    </div>
  {/if}
  {@render actions()}
</div>
