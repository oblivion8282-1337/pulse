<!--
  Inline invite card rendered inside a message when the content contains an
  `/invite/<code>` URL. Fetches the preview on mount and shows server name,
  icon, member count, and a "Beitreten"-button.

  ``host`` (bare FQDN) ist gesetzt, wenn der Link auf einen Self-Host zeigt.
  Dann können wir die Preview NICHT inline laden — der Empfänger ist meist
  noch kein Mitglied dieses Servers. Wir zeigen eine schlanke Karte und
  rufen `joinGuildByInvite` direkt auf (Cert-Login-Flow).
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { chatApi } from '$lib/api/chat';
  import { ApiError } from '$lib/api/client';
  import type { InvitePreview } from '$lib/api/types';
  import { Button } from '$lib/components/ui/button/index.js';
  import * as Avatar from '$lib/components/ui/avatar/index.js';
  import { guilds } from '$lib/stores/guilds.svelte';
  import { joinGuildByInvite } from '$lib/guilds/joinByInvite';
  import { toast } from 'svelte-sonner';
  import { m } from '$lib/paraglide/messages.js';

  let { code, host = null }: { code: string; host?: string | null } = $props();

  let preview = $state<InvitePreview | null>(null);
  let invalid = $state(false);
  let loading = $state(true);
  let joining = $state(false);

  let alreadyMember = $derived(!!preview && !!guilds.byId[preview.guild.id]);

  onMount(async () => {
    if (host) {
      loading = false;
      return;
    }
    try {
      preview = await chatApi.getInvitePreview(code);
    } catch (e) {
      invalid = true;
    } finally {
      loading = false;
    }
  });

  function guildInitial(name: string): string {
    return name.trim().charAt(0).toUpperCase();
  }

  async function handleJoin() {
    if (joining) return;
    joining = true;
    try {
      const input = host ? `https://app/invite/${code}?host=${encodeURIComponent(host)}` : code;
      await joinGuildByInvite(input);
    } catch (e) {
      toast.error(m.invite_embed_invalid(), {
        description: e instanceof Error ? e.message : undefined
      });
    } finally {
      joining = false;
    }
  }
</script>

<div
  class="mt-1 flex items-center gap-3 rounded-xl border border-border bg-bg-elev px-4 py-3 max-w-sm"
  data-testid="invite-embed"
>
  {#if loading}
    <div class="flex flex-1 items-center gap-3">
      <div class="size-10 shrink-0 rounded-full bg-bg-hover animate-pulse"></div>
      <div class="space-y-1.5 flex-1">
        <div class="h-3.5 w-32 rounded bg-bg-hover animate-pulse"></div>
        <div class="h-3 w-20 rounded bg-bg-hover animate-pulse"></div>
      </div>
    </div>
    <div class="h-8 w-20 rounded-lg bg-bg-hover animate-pulse shrink-0"></div>
  {:else if host}
    <Avatar.Root class="size-10 shrink-0">
      <Avatar.Fallback class="accent-gradient text-primary-foreground text-sm font-semibold">
        {guildInitial(host)}
      </Avatar.Fallback>
    </Avatar.Root>
    <div class="min-w-0 flex-1">
      <p class="text-text-bright truncate text-sm font-semibold">
        {m.invite_embed_self_host_title()}
      </p>
      <p class="text-text-muted truncate text-xs" data-testid="invite-embed-host">{host}</p>
    </div>
    <Button size="sm" onclick={handleJoin} disabled={joining} data-testid="invite-embed-join-btn">
      {joining ? '…' : m.invite_embed_join()}
    </Button>
  {:else if invalid || !preview}
    <div class="text-text-muted flex-1 text-sm">{m.invite_embed_invalid()}</div>
    <Button variant="outline" size="sm" disabled>{m.invite_embed_join()}</Button>
  {:else}
    <Avatar.Root class="size-10 shrink-0">
      {#if preview.guild.icon_url}
        <Avatar.Image src={preview.guild.icon_url} alt={preview.guild.name} />
      {/if}
      <Avatar.Fallback class="accent-gradient text-primary-foreground text-sm font-semibold">
        {guildInitial(preview.guild.name)}
      </Avatar.Fallback>
    </Avatar.Root>
    <div class="min-w-0 flex-1">
      <p class="text-text-bright truncate text-sm font-semibold" data-testid="invite-embed-guild-name">
        {preview.guild.name}
      </p>
      <p class="text-text-muted text-xs" data-testid="invite-embed-member-count">
        {m.invite_embed_member_count({ count: preview.member_count })}
      </p>
    </div>
    <Button
      size="sm"
      onclick={handleJoin}
      disabled={alreadyMember || joining}
      data-testid="invite-embed-join-btn"
    >
      {alreadyMember ? m.invite_embed_joined() : joining ? '…' : m.invite_embed_join()}
    </Button>
  {/if}
</div>
