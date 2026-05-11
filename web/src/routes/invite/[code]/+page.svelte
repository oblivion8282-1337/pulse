<script lang="ts">
  import { goto } from '$app/navigation';
  import { page } from '$app/stores';
  import { onMount } from 'svelte';
  import { auth } from '$lib/stores/auth.svelte';
  import { guilds } from '$lib/stores/guilds.svelte';
  import { chatApi } from '$lib/api/chat';
  import { ApiError } from '$lib/api/client';
  import type { InvitePreview } from '$lib/api/types';
  import { Button } from '$lib/components/ui/button/index.js';
  import * as Alert from '$lib/components/ui/alert/index.js';
  import OctagonXIcon from '@lucide/svelte/icons/octagon-x';

  let code = $derived($page.params.code ?? '');
  let preview = $state<InvitePreview | null>(null);
  let invalid = $state(false);
  let busy = $state(false);
  let error = $state<string | null>(null);

  onMount(async () => {
    await auth.hydrate();
    try {
      preview = await chatApi.getInvitePreview(code);
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) {
        invalid = true;
      } else {
        error = (e as Error).message;
      }
    }
  });

  function guildInitial(name: string): string {
    return name.trim().charAt(0).toUpperCase();
  }

  async function join() {
    if (!auth.isAuthenticated) {
      await goto(`/login?redirect=${encodeURIComponent('/invite/' + code)}`);
      return;
    }
    busy = true;
    error = null;
    try {
      const result = await chatApi.acceptInvite(code);
      await guilds.hydrate();
      const guildId = result.guild.id;
      if (result.channel_id) {
        await goto(`/app/guilds/${guildId}/channels/${result.channel_id}`);
      } else {
        await goto(`/app`);
      }
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) {
        invalid = true;
      } else {
        error = (e as Error).message;
      }
    } finally {
      busy = false;
    }
  }
</script>

<div class="flex min-h-screen items-center justify-center p-4">
  <div class="bg-card w-full max-w-sm space-y-6 rounded-xl p-8 shadow-2xl text-center">
    {#if invalid}
      <Alert.Root variant="destructive" data-testid="invite-invalid">
        <OctagonXIcon />
        <Alert.Description>Diese Einladung ist ungültig oder abgelaufen.</Alert.Description>
      </Alert.Root>
      <a class="text-primary hover:underline text-sm" href="/app">Zurück zur App</a>
    {:else if preview}
      <div class="space-y-3">
        {#if preview.guild.icon_url}
          <img
            src={preview.guild.icon_url}
            alt={preview.guild.name}
            class="mx-auto size-20 rounded-full object-cover"
          />
        {:else}
          <div
            class="bg-primary text-primary-foreground mx-auto flex size-20 items-center justify-center rounded-full text-3xl font-bold"
            aria-hidden="true"
          >
            {guildInitial(preview.guild.name)}
          </div>
        {/if}
        <p class="text-muted-foreground text-sm">Du wurdest eingeladen zu</p>
        <h1 class="text-card-foreground text-2xl font-semibold" data-testid="invite-guild-name">
          {preview.guild.name}
        </h1>
        <p class="text-muted-foreground text-sm" data-testid="invite-member-count">
          {preview.member_count} {preview.member_count === 1 ? 'Mitglied' : 'Mitglieder'}
        </p>
      </div>

      {#if error}
        <Alert.Root variant="destructive">
          <OctagonXIcon />
          <Alert.Description>{error}</Alert.Description>
        </Alert.Root>
      {/if}

      <Button
        class="w-full"
        onclick={join}
        disabled={busy}
        data-testid="invite-join-btn"
      >
        {busy ? 'Beitreten…' : 'Server beitreten'}
      </Button>
    {:else if error}
      <Alert.Root variant="destructive" data-testid="invite-load-error">
        <OctagonXIcon />
        <Alert.Description>{error}</Alert.Description>
      </Alert.Root>
    {:else}
      <p class="text-muted-foreground text-sm">Einladung wird geladen…</p>
    {/if}
  </div>
</div>
