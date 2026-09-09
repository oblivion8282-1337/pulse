<!--
  SettingsStandplatzKlappe — eine eingeklappte Karte mit Zusammenfassung.

  Profil und Protokoll im Reiter Remote-Rechner braucht man selten, sie
  nahmen aber die halbe Seite ein. Zugeklappt zeigt die Kopfzeile, was gilt
  (die Zusammenfassung), aufgeklappt das volle Formular darunter.
-->
<script lang="ts">
  import type { Component } from 'svelte';
  import type { Snippet } from 'svelte';
  import ChevronDownIcon from '@lucide/svelte/icons/chevron-down';

  let {
    icon: Icon,
    title,
    summary,
    testid,
    children,
  }: {
    icon: Component<{ class?: string }>;
    title: string;
    summary: string;
    testid: string;
    children: Snippet;
  } = $props();

  let offen = $state(false);
</script>

<div class="border-border flex flex-col rounded-2xl border" data-testid={testid}>
  <button
    type="button"
    class="hover:bg-bg-hover flex w-full items-center gap-3 rounded-2xl p-4 text-left transition-colors"
    aria-expanded={offen}
    onclick={() => (offen = !offen)}
    data-testid={`${testid}-toggle`}
  >
    <Icon class="text-text-muted size-4 shrink-0" />
    <span class="flex min-w-0 flex-1 flex-col">
      <span class="text-text-bright text-sm font-semibold">{title}</span>
      <span class="text-text-muted truncate text-xs">{summary}</span>
    </span>
    <ChevronDownIcon class="text-text-muted size-4 shrink-0 transition-transform {offen ? 'rotate-180' : ''}" />
  </button>
  {#if offen}
    <div class="border-border/60 border-t p-4 pt-3">
      {@render children()}
    </div>
  {/if}
</div>
