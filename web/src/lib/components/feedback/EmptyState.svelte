<!--
  „Hier ist nichts" — der leere Zustand einer Liste, Tabelle oder Auswahl.

  Ersetzt 11 handgebaute Varianten, die sich in Größe (`text-xs`/`text-sm`),
  Ausrichtung (mittig/linksbündig) und sechs verschiedenen Innenabständen
  unterschieden. Keine davon hatte ein Symbol oder ein Handlungsangebot.

  Zwei Dichten, weil beide Kontexte real vorkommen:
    * `density="compact"` (Vorgabe) — in Listen und Auswahlfeldern, wo der
      leere Zustand nur eine Zeile sein darf (ersetzt die `text-xs`-Fälle).
    * `density="page"` — als Inhalt einer ganzen Fläche, mittig, mit Luft.

  `icon` nimmt eine Lucide-Komponente. `children` ist Platz für eine Aktion
  („Ersten Kanal anlegen"), die es bisher nirgends gab:

      <EmptyState message={m.members_none()} />
      <EmptyState density="page" icon={InboxIcon} message="Keine Nachrichten">
        <Button size="sm">Schreib die erste</Button>
      </EmptyState>
-->
<script lang="ts">
  import type { Component, Snippet } from 'svelte';

  let {
    message,
    icon: Icon = undefined,
    density = 'compact',
    class: extraClass = '',
    testId = undefined,
    children = undefined
  }: {
    message: string;
    /** Lucide-Icon-Komponente. Nur bei `density="page"` sinnvoll sichtbar. */
    icon?: Component<{ class?: string }>;
    density?: 'compact' | 'page';
    class?: string;
    /** Wird als `data-testid` durchgereicht (Testids bleiben beim Umbau gleich). */
    testId?: string;
    /** Optionale Aktion unter dem Text. */
    children?: Snippet;
  } = $props();
</script>

{#if density === 'page'}
  <div
    class="text-text-muted flex flex-col items-center justify-center gap-3 px-4 py-10 text-center {extraClass}"
    data-testid={testId}
  >
    {#if Icon}
      <Icon class="size-8 opacity-60" />
    {/if}
    <p class="text-sm">{message}</p>
    {#if children}
      {@render children()}
    {/if}
  </div>
{:else}
  <!-- `text-sm` wie LoadingState: der Bestand war knapp gespalten (10x sm gegen
       7x xs), und zwei Zustände nebeneinander sollen nicht unterschiedlich gross
       sein. Sitzt der leere Zustand in einer sehr engen Liste, kann die
       Aufrufstelle über `class` nachjustieren — sparsam damit, sonst haben wir
       die alte Streuung zurück. -->
  <p class="text-text-muted px-3 py-2 text-sm {extraClass}" data-testid={testId}>{message}</p>
{/if}
