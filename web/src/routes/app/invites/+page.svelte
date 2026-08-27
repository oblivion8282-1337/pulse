<!--
  /app/invites — Community-Einladungen als eigener Ort.

  Warum eine eigene Route statt eines weiteren Reiters unter /app/friends:
  eine Einladung wartet auf eine Entscheidung. Hinter dem Drei-Punkte-Menü der
  Freunde-Seite (wo sie bis 2026-08-27 lag) sieht sie niemand, und ihr Zähler
  verschmolz dort mit dem der Freundschaftsanfragen zu einer Zahl, die vor dem
  Klick nichts aussagte.

  Der Rahmen ist bewusst identisch zu /app/friends aufgebaut (GuildRail +
  DM-Spalte + Panel), damit der Wechsel zwischen beiden nicht springt.
-->
<script lang="ts">
  import { goto } from '$app/navigation';
  import GuildRail from '$lib/components/GuildRail.svelte';
  import DMChannelList from '$lib/components/DMChannelList.svelte';
  import BereichsKopf from '$lib/components/mobile/BereichsKopf.svelte';
  import CommunityInviteCards from '$lib/components/friends/CommunityInviteCards.svelte';
  import { guilds } from '$lib/stores/guilds.svelte';
  import { communityInvites } from '$lib/stores/communityInvites.svelte';
  import { currentServerUserId } from '$lib/stores/currentServerUser';
  import { navDrawer } from '$lib/stores/navDrawer.svelte';
  import { viewport } from '$lib/stores/viewport.svelte';
  import type { DMChannel } from '$lib/api/types';

  async function selectGuild(g: { id: string }) {
    navDrawer.open = true;
    await goto(`/app/guilds/${g.id}/channels/_`);
  }

  async function selectDM(dm: DMChannel) {
    navDrawer.open = false;
    await goto(`/app/@me/${dm.id}`);
  }
</script>

<GuildRail
  guilds={guilds.list}
  activeGuildId={''}
  currentUserId={currentServerUserId()}
  homeActive={true}
  onSelect={selectGuild}
  onCreateClick={() => goto('/app?add=create')}
  onJoinClick={() => goto('/app?add=join')}
  onHomeClick={async () => {
    navDrawer.open = !navDrawer.open;
    await goto('/app/friends');
  }}
/>

{#if !viewport.isMobile}
  <DMChannelList activeDMId={null} onSelect={selectDM} />
{/if}

<section
  class="glass-panel flex h-full min-w-0 flex-1 flex-col overflow-hidden rounded-none md:rounded-2xl"
  data-testid="invites-page"
>
  <BereichsKopf titel="Einladungen" />

  <div class="flex-1 overflow-y-auto px-4 pb-4">
    {#if communityInvites.list.length === 0}
      <p class="text-text-muted px-1 pt-4 text-sm" data-testid="invites-empty">
        Keine offenen Einladungen.
      </p>
    {:else}
      <CommunityInviteCards />
    {/if}
  </div>
</section>
