<!--
  Inline invite card rendered inside a message when the content contains an
  `/invite/<code>` URL. Fetches the preview on mount and shows server name,
  icon, member count, and a "Beitreten"-button that navigates to /invite/<code>.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { chatApi } from '$lib/api/chat';
  import { ApiError } from '$lib/api/client';
  import type { InvitePreview } from '$lib/api/types';
  import { Button } from '$lib/components/ui/button/index.js';
  import * as Avatar from '$lib/components/ui/avatar/index.js';
  import { guilds } from '$lib/stores/guilds.svelte';
  import { m } from '$lib/paraglide/messages.js';

  let { code }: { code: string } = $props();

  let preview = $state<InvitePreview | null>(null);
  let invalid = $state(false);
  let loading = $state(true);

  // Already a member of the community this invite points to? Then "Beitreten"
  // makes no sense — disable it and relabel. `guilds.byId` holds exactly the
  // guilds the current user has joined.
  let alreadyMember = $derived(!!preview && !!guilds.byId[preview.guild.id]);

  onMount(async () => {
    try {
      preview = await chatApi.getInvitePreview(code);
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) {
        invalid = true;
      } else {
        invalid = true;
      }
    } finally {
      loading = false;
    }
  });

  function guildInitial(name: string): string {
    return name.trim().charAt(0).toUpperCase();
  }

  function handleJoin() {
    void goto(`/invite/${code}`);
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
      disabled={alreadyMember}
      data-testid="invite-embed-join-btn"
    >
      {alreadyMember ? m.invite_embed_joined() : m.invite_embed_join()}
    </Button>
  {/if}
</div>
