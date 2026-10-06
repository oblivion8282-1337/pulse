<!--
  Die drei Handlungen der Freunde-Kopfzeile als Symbole — nur ab `md`.

  Warum ausgelagert: mit dem Block inline stand +page.svelte bei 283 Zeilen und
  damit ueber der 250er-Grenze fuer Svelte-Komponenten (PLAN.md §12.1).
-->
<script lang="ts">
  import UserPlusIcon from '@lucide/svelte/icons/user-plus';
  import ClockIcon from '@lucide/svelte/icons/clock';
  import BanIcon from '@lucide/svelte/icons/ban';
  import { m } from '$lib/paraglide/messages.js';

  type TabKey = 'all' | 'pending' | 'blocked' | 'add';

  let {
    activeTab,
    pendingBadge,
    onSwitch
  }: {
    activeTab: TabKey;
    /** Nur offene Freundschaftsanfragen — Community-Einladungen haben seit dem
        eigenen Eintrag in der @me-Spalte ihren eigenen Zaehler. */
    pendingBadge: number;
    onSwitch: (key: TabKey) => void;
  } = $props();

  /**
   * Ein Symbol schaltet um, nicht nur ein: ein zweiter Klick auf das aktive
   * Symbol fuehrt zurueck zur Liste.
   *
   * Warum es das braucht: ab `md` ist die Zurueck-Zeile ausgeblendet (das
   * aktive Symbol zeigt den Ort ja an) — ohne Umschalten gab es aus
   * „Ausstehend" oder „Blockiert" keinen Weg mehr zur Freundesliste zurueck.
   */
  function umschalten(key: TabKey) {
    onSwitch(activeTab === key ? 'all' : key);
  }
</script>

    <!-- Ab `md` drei Symbole statt des Menues. Sie ueberstimmen bewusst die
         Hausregel von BereichsKopf („die Handlung traegt IMMER ein Wort") —
         deshalb traegt jedes `title` UND `aria-label`, damit weder Maus noch
         Screenreader raten muss. Auf `< md` bleibt das Menue: drei
         48-px-Flaechen nebeneinander kosten dort zu viel Breite. -->
    <div class="hidden items-center gap-0.5 md:flex">
      <button
        type="button"
        class="text-text-muted hover:bg-bg-hover hover:text-text-bright flex size-12 items-center justify-center rounded-[14px] transition-colors data-[active=true]:bg-[var(--accent-soft)] data-[active=true]:text-primary"
        data-active={activeTab === 'add'}
        onclick={() => umschalten('add')}
        title={m.friends_tab_add()}
        aria-label={m.friends_tab_add()}
        data-testid="friends-action-add"
      >
        <UserPlusIcon class="size-5" />
      </button>
      <button
        type="button"
        class="text-text-muted hover:bg-bg-hover hover:text-text-bright relative flex size-12 items-center justify-center rounded-[14px] transition-colors data-[active=true]:bg-[var(--accent-soft)] data-[active=true]:text-primary"
        data-active={activeTab === 'pending'}
        onclick={() => umschalten('pending')}
        title={m.friends_tab_pending()}
        aria-label={m.friends_tab_pending()}
        data-testid="friends-action-pending"
      >
        <ClockIcon class="size-5" />
        {#if pendingBadge > 0}
          <span
            class="bg-rose-500 absolute right-1.5 top-1.5 inline-flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-2xs font-semibold leading-none text-white"
            data-testid="friends-action-pending-badge"
          >
            {pendingBadge}
          </span>
        {/if}
      </button>
      <button
        type="button"
        class="text-text-muted hover:bg-bg-hover hover:text-text-bright flex size-12 items-center justify-center rounded-[14px] transition-colors data-[active=true]:bg-[var(--accent-soft)] data-[active=true]:text-primary"
        data-active={activeTab === 'blocked'}
        onclick={() => umschalten('blocked')}
        title={m.friends_tab_blocked()}
        aria-label={m.friends_tab_blocked()}
        data-testid="friends-action-blocked"
      >
        <BanIcon class="size-5" />
      </button>
    </div>
