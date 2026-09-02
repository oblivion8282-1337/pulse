<script lang="ts">
  /**
   * Eine private Gruppe in der Chats-Liste des Handys (Etappe G).
   *
   * Eigene Datei, weil `MobileChatsList.svelte` sonst ueber die Grenze fuer
   * Svelte-Komponenten (250 Zeilen) gewachsen waere — nicht, weil eine Gruppe
   * grundsaetzlich anders aussieht. Bewusst dieselbe Zeilenform wie eine DM
   * (Rahmen, Abstaende, Ungelesen-Merkmale), damit die Liste eine Liste
   * bleibt; verschieden ist nur, was verschieden IST: ein Sammelzeichen statt
   * eines Profilbilds, kein Anwesenheitspunkt (eine Gruppe ist nicht
   * „online"), und kein Vorschautext — der laege nur lokal vor, und die
   * Gruppenliste kommt vom Server ohne ihn.
   */
  import UsersIcon from '@lucide/svelte/icons/users';
  import { readState } from '$lib/stores/readState.svelte';
  import { m } from '$lib/paraglide/messages.js';
  import type { PrivateGruppe } from '$lib/api/gruppen';

  let {
    gruppe,
    onSelect
  }: {
    gruppe: PrivateGruppe;
    onSelect: (gruppeId: string) => void;
  } = $props();

  const ungelesen = $derived(readState.isUnread(gruppe.id));
  const zahl = $derived(readState.getUnreadCount(gruppe.id));
</script>

<button
  class="hover:bg-bg-hover border-border bg-bg-input flex w-full items-center gap-3 rounded-[14px] border p-2.5 text-left transition-colors"
  onclick={() => onSelect(gruppe.id)}
  data-testid={`chat-row-${gruppe.id}`}
  data-unread={ungelesen}
>
  <span
    class="text-text-muted flex size-[46px] shrink-0 items-center justify-center rounded-full"
    style="background-image: linear-gradient(135deg in oklab, var(--accent-grad-from), var(--accent-grad-to));"
  >
    <UsersIcon class="size-5 text-white" />
  </span>

  <span class="min-w-0 flex-1">
    <span class="flex items-center gap-2">
      <span
        class="truncate text-sm font-semibold {ungelesen ? 'text-text-bright' : 'text-text-base'}"
        >{gruppe.name}</span
      >
      {#if zahl > 0}
        <span
          class="bg-badge-count text-2xs ml-auto inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full px-1.5 font-extrabold leading-none text-white"
          data-testid="chat-row-unread"
          data-unread-count={zahl}
          aria-label={m.nav_tab_unread_badge({ count: zahl })}
          >{zahl > 99 ? '99+' : zahl}</span
        >
      {/if}
    </span>
  </span>
</button>
