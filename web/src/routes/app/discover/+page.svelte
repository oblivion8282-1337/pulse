<script lang="ts">
import { errText } from '$lib/utils/errText';
  /**
   * Entdecken — das Verzeichnis öffentlicher Communities.
   *
   * Zwei Wege hinein, und das ist Absicht: **oben** die Adresse, die dir
   * jemand geschickt hat (der Weg, den es schon immer gab), **darunter** das
   * Schaufenster für alles, was gefunden werden möchte.
   *
   * Im Schaufenster steht nur, was `is_public` **und** `listed` ist. Eine
   * öffentliche Adresse heisst „wer den Link kennt, kommt rein"; gelistet
   * heisst „ich möchte gefunden werden". Der Server hält die beiden
   * auseinander, und keine bestehende Community wurde ungefragt gelistet.
   */
  import { goto } from '$app/navigation';
  import { onMount } from 'svelte';
  import { toast } from 'svelte-sonner';
  import ChevronLeftIcon from '@lucide/svelte/icons/chevron-left';
  import SearchIcon from '@lucide/svelte/icons/search';
  import UsersIcon from '@lucide/svelte/icons/users';
  import { Button } from '$lib/components/ui/button/index.js';
  import { Input } from '$lib/components/ui/input/index.js';
  import { chatApi, COMMUNITY_CATEGORIES, type DirectoryEntry } from '$lib/api/chat';
  import { joinGuildByInvite } from '$lib/guilds/joinByInvite';
  import { activeServer } from '$lib/stores/active-server.svelte';
  import { guildIconSrc } from '$lib/guildIcon';
  import { initialen } from '$lib/utils/initialen';
  import { m } from '$lib/paraglide/messages.js';

  let suche = $state('');
  let kategorie = $state<string>('');
  let eintraege = $state<DirectoryEntry[]>([]);
  let laedt = $state(true);
  let adresse = $state('');
  let tretebei = $state(false);
  let beitreten = $state<string | null>(null);

  // Nachschlagetabelle statt Ternar-Kette: die Kategorien sind gleichrangig.
  // Eine unbekannte Kennung faellt auf „Sonstiges" — der Server kennt genau
  // dieselben fuenf (`community_categories.py`), aber ein aelterer Klient soll
  // an einer neuen Kategorie nicht mit einer leeren Stelle dastehen.
  const KATEGORIE_NAMEN: Record<string, () => string> = {
    gaming: m.community_category_gaming,
    music: m.community_category_music,
    tech: m.community_category_tech,
    creative: m.community_category_creative
  };

  function kategorieName(c: string): string {
    return (KATEGORIE_NAMEN[c] ?? m.community_category_other)();
  }

  async function laden() {
    laedt = true;
    try {
      const r = await chatApi.listPublicCommunities({
        q: suche.trim() || undefined,
        category: kategorie || undefined
      });
      eintraege = r.items;
    } catch {
      eintraege = [];
    } finally {
      laedt = false;
    }
  }

  onMount(laden);

  // Suche und Kategorie neu laden. Die Suche wird entprellt — sonst schickt
  // jeder Tastendruck eine Anfrage, und die Antworten kaemen in beliebiger
  // Reihenfolge zurueck.
  let entprellung: ReturnType<typeof setTimeout> | null = null;
  function sucheGeaendert() {
    if (entprellung) clearTimeout(entprellung);
    entprellung = setTimeout(() => void laden(), 300);
  }

  function kategorieWaehlen(c: string) {
    kategorie = kategorie === c ? '' : c;
    void laden();
  }

  async function perAdresse() {
    if (!adresse.trim() || tretebei) return;
    tretebei = true;
    try {
      await joinGuildByInvite(adresse.trim());
      adresse = '';
      await goto('/app/rooms');
    } catch (e) {
      toast.error(m.discover_join_failed(), {
        description: errText(e)
      });
    } finally {
      tretebei = false;
    }
  }

  async function karteBeitreten(e: DirectoryEntry) {
    if (beitreten) return;
    beitreten = e.id;
    try {
      await chatApi.joinPublicCommunity(e.handle);
      await goto('/app/rooms');
    } catch (err) {
      toast.error(m.discover_join_failed(), {
        description: err instanceof Error ? err.message : String(err)
      });
    } finally {
      beitreten = null;
    }
  }
</script>

<div
  class="glass-panel slide-rein flex h-full min-w-0 flex-1 flex-col overflow-hidden rounded-none md:rounded-2xl"
  data-testid="discover-page"
>
  <!-- Gleiche Kopfhöhe wie die anderen Bereichs-Screens (BereichsKopf:
       22px/800, pt-3.5/pb-2) — nur mit Zurück-Pfeil davor, weil Entdecken
       aus den Räumen heraus erreicht wird. Die alte Fassung war eine
       Detail-Screen-Leiste (h-14, 16px Titel, Trennlinie) und brach die Höhe. -->
  <header class="text-text-bright flex shrink-0 items-center justify-between gap-3 px-4 pb-2 pt-3.5">
    <div class="flex min-w-0 items-center gap-1">
      <button
        class="text-text-muted hover:text-primary -ml-2 flex min-h-12 min-w-12 items-center justify-center"
        onclick={() => goto('/app/rooms')}
        data-testid="discover-back"
        aria-label={m.channel_list_back()}
      >
        <ChevronLeftIcon class="size-6" />
      </button>
      <h1 class="truncate text-[22px] font-extrabold leading-tight tracking-[-0.02em]">
        {m.rooms_discover_cta()}
      </h1>
    </div>
  </header>

  <div class="flex-1 overflow-y-auto px-3 pb-4 pt-3">
    <!-- Suche -->
    <div class="relative mb-3">
      <SearchIcon
        class="text-text-muted pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2"
      />
      <Input
        bind:value={suche}
        oninput={sucheGeaendert}
        placeholder={m.discover_search_placeholder()}
        class="min-h-12 pl-9"
        data-testid="discover-search"
      />
    </div>

    <!-- Beitreten per Link oder Adresse — der Weg, den es schon gab. -->
    <div class="bg-bg-input border-border mb-4 rounded-[14px] border p-3">
      <div class="text-text-bright mb-1.5 text-sm font-semibold">
        {m.discover_join_by_link_label()}
      </div>
      <!-- Untereinander statt nebeneinander: auf 393 px blieben dem Feld
           neben dem Knopf rund 240 px, und der Platzhalter wurde mitten im
           Wort abgeschnitten. Ein Feld, dessen eigene Beschriftung nicht
           hineinpasst, sieht kaputt aus, bevor man es angefasst hat. -->
      <Input
        bind:value={adresse}
        placeholder={m.discover_join_by_link_placeholder()}
        class="min-h-12 w-full"
        data-testid="discover-join-input"
        onkeydown={(e: KeyboardEvent) => {
          if (e.key === 'Enter') void perAdresse();
        }}
      />
      <Button
        class="mt-2 min-h-12 w-full"
        disabled={!adresse.trim() || tretebei}
        onclick={perAdresse}
        data-testid="discover-join-submit"
      >
        {m.discover_join()}
      </Button>
    </div>

    <!-- Kategorie-Chips. „Alle" ist derselbe Knopf wie die fuenf anderen, nur
         mit der leeren Kennung — deshalb ein Schnipsel statt zweier Bloecke,
         die dieselben acht Klassen tragen. -->
    {#snippet chip(wert: string, text: string, testid: string)}
      <button
        class="flex min-h-12 shrink-0 items-center rounded-full px-3.5 text-[13px] font-semibold transition-colors {kategorie ===
        wert
          ? 'bg-[var(--accent-soft)] text-accent-on-soft'
          : 'bg-bg-input text-text-muted'}"
        onclick={() => kategorieWaehlen(wert)}
        data-testid={testid}
      >{text}</button>
    {/snippet}
    <div class="-mx-1 mb-3 flex gap-1.5 overflow-x-auto px-1">
      {@render chip('', m.discover_category_all(), 'discover-category-all')}
      {#each COMMUNITY_CATEGORIES as c (c)}
        {@render chip(c, kategorieName(c), `discover-category-${c}`)}
      {/each}
    </div>

    <!-- Karten -->
    {#if !laedt && eintraege.length === 0}
      <p class="text-text-muted px-2 py-8 text-center text-sm">{m.discover_empty()}</p>
    {/if}
    <div class="flex flex-col gap-2.5">
      {#each eintraege as e (e.id)}
        {@const iconSrc = guildIconSrc(e.icon_url, activeServer.current?.hostname)}
        <div
          class="bg-bg-input border-border flex items-center gap-3 rounded-[14px] border p-3"
          data-testid={`discover-card-${e.handle}`}
        >
          <span
            class="flex size-12 shrink-0 items-center justify-center overflow-hidden rounded-[14px] text-base font-bold text-white"
            style={iconSrc
              ? ''
              : 'background-image: linear-gradient(135deg in oklab, var(--accent-grad-from), var(--accent-grad-to));'}
          >
            {#if iconSrc}
              <img src={iconSrc} alt={e.name} class="size-full object-cover" />
            {:else}
              {initialen(e.name)}
            {/if}
          </span>
          <div class="min-w-0 flex-1">
            <div class="text-text-bright truncate text-sm font-semibold">{e.name}</div>
            <div class="text-text-muted flex items-center gap-1.5 text-xs">
              <UsersIcon class="size-3.5" />
              {m.discover_members({ count: e.member_count })}
              {#if e.category}
                <span aria-hidden="true">·</span>
                <span>{kategorieName(e.category)}</span>
              {/if}
            </div>
          </div>
          <Button
            class="min-h-12 shrink-0"
            disabled={beitreten === e.id}
            onclick={() => karteBeitreten(e)}
            data-testid={`discover-join-${e.handle}`}
          >
            {m.discover_join()}
          </Button>
        </div>
      {/each}
    </div>
  </div>
</div>
