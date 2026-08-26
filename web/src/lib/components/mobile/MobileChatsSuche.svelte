<script lang="ts">
  /**
   * Die Trefferliste der Chats-Suche: Personen aus der eigenen Gesprächsliste,
   * Text-Kanäle der eigenen Communities, Nachrichten aus der DM-Historie.
   *
   * **Eigene Komponente, weil es ein eigener Bildschirmzustand ist.** Solange
   * gesucht wird, ersetzt diese Liste die Gesprächsliste vollständig; die
   * beiden teilen sich nur die Suchleiste darüber. In einer Datei zusammen
   * waren es 471 Zeilen mit drei unabhängigen Anliegen.
   */
  import HashIcon from '@lucide/svelte/icons/hash';
  import { goto } from '$app/navigation';
  import { auth } from '$lib/stores/auth.svelte';
  import { guilds } from '$lib/stores/guilds.svelte';
  import { directMessages } from '$lib/stores/directMessages.svelte';
  import { userCache } from '$lib/stores/users.svelte';
  import { nameStyle } from '$lib/utils/nameColor';
  import { safeAvatarUrl } from '$lib/avatar';
  import { kurzeUhrzeit } from '$lib/utils/kurzeUhrzeit';
  import { suchnorm, namePasst } from '$lib/utils/suche';
  import { chatApi, type DMMessageSearchHit } from '$lib/api/chat';
  import type { DMChannel, Channel as ChannelTyp } from '$lib/api/types';
  import { m } from '$lib/paraglide/messages.js';

  let {
    suchbegriff,
    roheEingabe,
    onSelect
  }: {
    /** Normalisierte Eingabe ab drei Zeichen — nie leer, nie null. */
    suchbegriff: string;
    /** Die ungetrimmte Eingabe für den Server (er sucht im Originaltext). */
    roheEingabe: string;
    onSelect: (dm: DMChannel) => void;
  } = $props();

  let treffer = $state<DMMessageSearchHit[]>([]);
  let sucht = $state(false);

  /** Gefilterte Gespräche nach Namen — lokal über den Store, kein Roundtrip.
   *  Namen mit Zahlen werden über alle drei Pfade getroffen (`namePasst`). */
  let personenTreffer = $derived(
    directMessages.list.filter((dm) =>
      namePasst(userCache.displayName(dm.other_user_id), suchbegriff)
    )
  );

  /** Text-Kanäle der eigenen Communities, deren Name passt. */
  let kanalTreffer = $derived.by(() => {
    const gefunden: { guild: { id: string; name: string }; kanal: ChannelTyp }[] = [];
    for (const g of guilds.list) {
      for (const c of guilds.channelsByGuild[g.id] ?? []) {
        if (c.type !== 0) continue; // nur Text-Kanäle
        if (suchnorm(c.name).includes(suchbegriff)) {
          gefunden.push({ guild: { id: g.id, name: g.name }, kanal: c });
        }
      }
    }
    return gefunden;
  });

  // Kanal-Cache der Communities EINMAL auffüllen — ohne das bliebe die
  // Kanal-Suche bei Nutzern leer, die noch in keiner Community unterwegs
  // waren. Der Merker ist nötig, weil `suchbegriff` bei jedem Tastendruck ein
  // neuer String ist: ohne ihn feuerte der Effekt pro Buchstabe eine Anfrage
  // je Community — wer in dreissig Communities ist, löste beim dritten
  // Zeichen dreissig gleichzeitige Anfragen aus.
  let kanaeleGeladen = false;
  $effect(() => {
    if (kanaeleGeladen) return;
    kanaeleGeladen = true;
    for (const g of guilds.list) {
      void guilds.ensureChannels(g.id).catch(() => undefined);
    }
  });

  // Nachrichtensuche mit 300 ms Entprellung; überholte Antworten verwerfen.
  let suchlauf = 0;
  $effect(() => {
    const q = roheEingabe.trim();
    const lauf = ++suchlauf;
    const timer = setTimeout(async () => {
      try {
        const ergebnis = await chatApi.searchDMMessages(q);
        if (lauf === suchlauf) treffer = ergebnis;
      } catch {
        if (lauf === suchlauf) treffer = [];
      } finally {
        if (lauf === suchlauf) sucht = false;
      }
    }, 300);
    sucht = true;
    return () => clearTimeout(timer);
  });

  /** Gespräch öffnen — auch für Treffer, deren Kanal noch nicht im Store ist. */
  async function oeffneTreffer(hit: DMMessageSearchHit) {
    const bekannt = directMessages.byId[hit.dm_channel_id];
    if (bekannt) {
      onSelect(bekannt);
      return;
    }
    try {
      const dm = await chatApi.getDMChannel(hit.dm_channel_id);
      directMessages.upsert(dm);
      onSelect(dm);
    } catch {
      /* Kanal weg — Liste neu hydraten bleibt dem Store überlassen. */
    }
  }

  function initialen(name: string): string {
    return name.slice(0, 1).toUpperCase();
  }

  const ZEILE =
    'hover:bg-bg-hover border-border bg-bg-input flex w-full items-center gap-3 rounded-[14px] border p-2.5 text-left transition-colors';
  const UEBERSCHRIFT =
    'text-text-muted px-2 pt-1 text-[11px] font-semibold uppercase tracking-wide';
</script>

{#if personenTreffer.length === 0 && kanalTreffer.length === 0 && treffer.length === 0 && !sucht}
  <p class="text-text-muted px-4 pt-8 text-center text-xs" data-testid="chats-search-empty">
    {m.chats_search_no_results()}
  </p>
{/if}

{#if personenTreffer.length > 0}
  <span class={UEBERSCHRIFT}>{m.chats_search_section_people()}</span>
{/if}
{#each personenTreffer as dm (dm.id)}
  {@const name = userCache.displayName(dm.other_user_id)}
  {@const bild = safeAvatarUrl(userCache.get(dm.other_user_id)?.avatar_url ?? null)}
  <button class={ZEILE} onclick={() => onSelect(dm)} data-testid={`search-row-person-${dm.id}`}>
    <span class="size-[38px] shrink-0">
      {#if bild}
        <img src={bild} alt="" class="size-full rounded-full object-cover" />
      {:else}
        <span
          class="flex size-full items-center justify-center rounded-full text-sm font-bold text-white"
          style="background-image: linear-gradient(135deg in oklab, var(--accent-grad-from), var(--accent-grad-to));"
          >{initialen(name)}</span
        >
      {/if}
    </span>
    <span class="truncate text-sm font-semibold" style={nameStyle(dm.other_user_id)}>{name}</span>
  </button>
{/each}

{#if kanalTreffer.length > 0}
  <span class={UEBERSCHRIFT}>{m.chats_search_section_channels()}</span>
{/if}
{#each kanalTreffer as t_k (t_k.kanal.id)}
  <button
    class={ZEILE}
    onclick={() => goto(`/app/guilds/${t_k.guild.id}/channels/${t_k.kanal.id}`)}
    data-testid={`search-row-channel-${t_k.kanal.id}`}
  >
    <span
      class="text-text-muted bg-bg-hover flex size-[38px] shrink-0 items-center justify-center rounded-full"
    >
      <HashIcon class="size-5" />
    </span>
    <span class="min-w-0 flex-1">
      <span class="block truncate text-sm font-semibold">{t_k.kanal.name}</span>
      <span class="text-text-muted block truncate text-xs">{t_k.guild.name}</span>
    </span>
  </button>
{/each}

{#if treffer.length > 0 || sucht}
  <span class={UEBERSCHRIFT}>{m.chats_search_section_messages()}</span>
{/if}
{#if sucht}
  <p class="text-text-muted px-4 py-3 text-xs">{m.chats_searching()}</p>
{/if}
{#each treffer as hit (hit.message_id)}
  {@const name = userCache.displayName(hit.other_user_id)}
  {@const vonMir = !!auth.user && hit.author_id === auth.user.id}
  <button
    class="hover:bg-bg-hover border-border bg-bg-input flex w-full flex-col gap-1 rounded-[14px] border p-2.5 text-left transition-colors"
    onclick={() => oeffneTreffer(hit)}
    data-testid={`search-row-message-${hit.message_id}`}
  >
    <span class="flex items-center gap-2">
      <span class="truncate text-sm font-semibold" style={nameStyle(hit.other_user_id)}>{name}</span
      >
      <time class="text-text-muted text-2xs ml-auto shrink-0">{kurzeUhrzeit(hit.created_at)}</time>
    </span>
    <span class="text-text-muted line-clamp-2 text-xs"
      >{vonMir ? m.dm_preview_own_prefix() : ''}{hit.content}</span
    >
  </button>
{/each}
