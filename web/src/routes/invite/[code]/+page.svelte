<script lang="ts">
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { onMount } from 'svelte';
  import { auth } from '$lib/stores/auth.svelte';
  import { guilds } from '$lib/stores/guilds.svelte';
  import { chatApi } from '$lib/api/chat';
  import { ApiError } from '$lib/api/client';
  import type { InvitePreview } from '$lib/api/types';
  import { serversStore } from '$lib/api/servers.svelte';
  import { activeServer } from '$lib/stores/active-server.svelte';
  import { Button } from '$lib/components/ui/button/index.js';
  import * as Alert from '$lib/components/ui/alert/index.js';
  import OctagonXIcon from '@lucide/svelte/icons/octagon-x';
  import { m } from '$lib/paraglide/messages.js';

  let code = $derived(page.params.code ?? '');

  // Deep-link: when arriving from a pulse://invite URL main passes `?host=`
  // with a validated FQDN. We construct the full HTTPS hostname and look it
  // up (or add it) in the servers store before loading the preview.
  let rawHost = $derived(page.url.searchParams.get('host') ?? '');
  // Normalise: upgrade http:// to https:// and prepend https:// if missing,
  // strip trailing slash. (Cert-login requires HTTPS to protect the cert payload.)
  let deepLinkHostname = $derived(
    rawHost
      ? (() => {
          const trimmed = rawHost.trim().toLowerCase().replace(/\/$/, '');
          if (trimmed.startsWith('http://')) {
            return `https://${trimmed.slice('http://'.length)}`;
          }
          if (!trimmed.startsWith('https://')) {
            return `https://${trimmed}`;
          }
          return trimmed;
        })()
      : ''
  );

  // Phase 5.3: when a deep-link host is present we show a disclaimer first.
  // `confirmed` flips after the user clicks "Weiter" — only then do we load
  // the preview (and possibly switch the active server).
  let confirmed = $state(false);

  let preview = $state<InvitePreview | null>(null);
  let invalid = $state(false);
  let busy = $state(false);
  let error = $state<string | null>(null);

  // Already in this community? Then "Beitreten" is a no-op — disable it and
  // offer a way back instead of a dead end. `guilds.byId` holds the guilds the
  // current user has joined. (Same guard as InviteEmbed in the chat card.)
  let alreadyMember = $derived(!!preview && !!guilds.byId[preview.guild.id]);

  // Ensure the deep-link server is in the store and switched to active.
  function ensureDeepLinkServer(): void {
    if (!deepLinkHostname) return;
    let entry = serversStore.findByHostname(deepLinkHostname);
    if (!entry) {
      entry = serversStore.add(deepLinkHostname);
    }
    activeServer.set(entry.id);
  }

  async function loadPreview(): Promise<void> {
    try {
      preview = await chatApi.getInvitePreview(code);
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) {
        invalid = true;
      } else {
        error = (e as Error).message;
      }
    }
  }

  onMount(async () => {
    await auth.hydrate();
    // For plain browser invites (no deep-link host) load immediately.
    // For deep-link invites wait until the user confirms the disclaimer.
    if (!deepLinkHostname) {
      await loadPreview();
    }
  });

  async function handleConfirm(): Promise<void> {
    ensureDeepLinkServer();
    confirmed = true;
    await loadPreview();
  }

  function guildInitial(name: string): string {
    return name.trim().charAt(0).toUpperCase();
  }

  async function join() {
    if (!auth.isAuthenticated) {
      const redirect = deepLinkHostname
        ? `/invite/${code}?host=${encodeURIComponent(rawHost)}`
        : `/invite/${code}`;
      await goto(`/login?redirect=${encodeURIComponent(redirect)}`);
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

<div class="flex min-h-dvh items-center justify-center p-4">
  <div class="bg-card w-full max-w-sm space-y-6 rounded-xl p-8 shadow-2xl text-center">
    {#if deepLinkHostname && !confirmed}
      <!-- Deep-link disclaimer: shown before any server contact -->
      <div class="space-y-3">
        <div
          class="bg-primary text-primary-foreground mx-auto flex size-14 items-center justify-center rounded-full text-2xl font-bold"
          aria-hidden="true"
        >
          ?
        </div>
        <h1 class="text-card-foreground text-xl font-semibold">{m.invite_page_deep_link_title()}</h1>
        <p class="text-muted-foreground text-sm">
          {m.invite_page_deep_link_from_external()}
        </p>
        <p class="text-card-foreground break-all font-mono text-sm font-medium" data-testid="invite-deep-link-host">
          {deepLinkHostname}
        </p>
        <p class="text-muted-foreground text-xs">
          {m.invite_page_deep_link_hint()}
        </p>
      </div>
      <Button class="w-full" onclick={handleConfirm} data-testid="invite-confirm-btn">
        {m.invite_page_confirm()}
      </Button>
      <a class="text-primary hover:underline text-sm block" href="/app">{m.invite_page_cancel()}</a>
    {:else if invalid}
      <Alert.Root variant="destructive" data-testid="invite-invalid">
        <OctagonXIcon />
        <Alert.Description>{m.invite_page_invalid()}</Alert.Description>
      </Alert.Root>
      <a class="text-primary hover:underline text-sm" href="/app">{m.invite_page_back_to_app()}</a>
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
        <p class="text-muted-foreground text-sm">{m.invite_page_you_were_invited()}</p>
        <h1 class="text-card-foreground text-2xl font-semibold" data-testid="invite-guild-name">
          {preview.guild.name}
        </h1>
        <p class="text-muted-foreground text-sm" data-testid="invite-member-count">
          {m.invite_page_member_count({ count: preview.member_count })}
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
        disabled={busy || alreadyMember}
        data-testid="invite-join-btn"
      >
        {alreadyMember
          ? m.invite_page_already_member()
          : busy
            ? m.invite_page_joining()
            : m.invite_page_join()}
      </Button>
      {#if alreadyMember}
        <a class="text-primary hover:underline text-sm block" href="/app">{m.invite_page_back_to_app()}</a>
      {/if}
    {:else if error}
      <Alert.Root variant="destructive" data-testid="invite-load-error">
        <OctagonXIcon />
        <Alert.Description>{error}</Alert.Description>
      </Alert.Root>
    {:else}
      <p class="text-muted-foreground text-sm">{m.invite_page_loading()}</p>
    {/if}
  </div>
</div>
