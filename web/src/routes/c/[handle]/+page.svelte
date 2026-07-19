<!--
  Public community landing page: /c/<handle>[?host=<fqdn>]

  The backend (public_community.py) + API client were ready; this is the
  missing SvelteKit route, so a shared community address now resolves to a
  real preview + join instead of falling through to the SPA root.

  Logged in  → fetch the preview (cloud) + a Join button (joinGuildByInvite
               handles cloud + cross-server self-host).
  Logged out → "Sign in to join" → /login?pendingAddress=<handle> so the
               login flow joins automatically afterwards.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { page } from '$app/state';
  import { goto } from '$app/navigation';
  import { toast } from 'svelte-sonner';
  import * as Avatar from '$lib/components/ui/avatar/index.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import { chatApi, type PublicCommunityPreview } from '$lib/api/chat';
  import { auth } from '$lib/stores/auth.svelte';
  import { joinGuildByInvite } from '$lib/guilds/joinByInvite';
  import { SelfHostContactConfirmRequired } from '$lib/api/add-server-flow';
  import SelfHostContactConfirmDialog from '$lib/components/server/SelfHostContactConfirmDialog.svelte';
  import LoadingState from '$lib/components/feedback/LoadingState.svelte';
  import { m } from '$lib/paraglide/messages.js';

  const handle = $derived(page.params.handle ?? '');
  const host = $derived(page.url.searchParams.get('host'));
  const joinInput = $derived(host ? `https://${host}/c/${handle}` : `c/${handle}`);

  let preview = $state<PublicCommunityPreview | null>(null);
  let loading = $state(true);
  let busy = $state(false);
  let confirmOpen = $state(false);

  onMount(async () => {
    // Auth is only hydrated inside the /app layout; this route lives outside it.
    // Without hydrating here, an already-signed-in user opening a shared /c/ link
    // (fresh load / new tab) would see "sign in to join" and be bounced through a
    // needless re-login. hydrate() is idempotent + best-effort.
    await auth.hydrate().catch(() => {});

    // Best-effort preview — cloud communities resolve unauthenticated. Self-host
    // (host set) needs the user's session on that server, so we skip the preview
    // there and still offer the join (joinGuildByInvite does the cert-login).
    if (!host) {
      try {
        preview = await chatApi.getPublicCommunityPreview(handle);
      } catch {
        preview = null;
      }
    }
    loading = false;
  });

  async function doJoin(confirmed = false) {
    if (busy) return;
    if (!auth.user) {
      const params = new URLSearchParams({ pendingAddress: handle });
      if (host) params.set('pendingHost', host);
      await goto(`/login?${params.toString()}`);
      return;
    }
    busy = true;
    try {
      await joinGuildByInvite(joinInput, confirmed);
      // joinGuildByInvite navigates to the joined guild on success.
    } catch (e) {
      if (e instanceof SelfHostContactConfirmRequired) {
        confirmOpen = true;
        return;
      }
      toast.error(m.public_community_join_failed(), {
        description: e instanceof Error ? e.message : String(e)
      });
    } finally {
      busy = false;
    }
  }

  function initial(name: string): string {
    return name.trim().charAt(0).toUpperCase() || '?';
  }
</script>

<div class="flex min-h-dvh items-center justify-center bg-bg-base p-6">
  <div
    class="border-border bg-bg-input/40 flex w-full max-w-sm flex-col items-center gap-5 rounded-2xl border p-8 text-center"
    data-testid="public-community-card"
  >
    {#if loading}
      <LoadingState label={m.public_community_loading()} />
    {:else}
      <Avatar.Root class="size-20">
        {#if preview?.guild.icon_url}
          <Avatar.Image src={preview.guild.icon_url} alt={preview.guild.name} />
        {/if}
        <Avatar.Fallback class="accent-gradient text-primary-foreground text-2xl font-semibold">
          {initial(preview?.guild.name ?? handle)}
        </Avatar.Fallback>
      </Avatar.Root>

      <div class="flex flex-col gap-1">
        <h1 class="text-text-bright text-xl font-semibold" data-testid="public-community-name">
          {preview?.guild.name ?? handle}
        </h1>
        {#if preview}
          <p class="text-text-muted text-xs">
            {m.public_community_member_count({ count: preview.member_count })}
          </p>
        {:else}
          <p class="text-text-muted text-xs">@{handle}</p>
        {/if}
      </div>

      <Button class="w-full" onclick={() => doJoin()} disabled={busy} data-testid="public-community-join">
        {#if busy}
          {m.public_community_joining()}
        {:else if auth.user}
          {m.public_community_join()}
        {:else}
          {m.public_community_signin_to_join()}
        {/if}
      </Button>
    {/if}
  </div>
</div>

<SelfHostContactConfirmDialog
  open={confirmOpen}
  hostname={host ?? ''}
  onConfirm={() => {
    confirmOpen = false;
    void doJoin(true);
  }}
  onCancel={() => (confirmOpen = false)}
/>
