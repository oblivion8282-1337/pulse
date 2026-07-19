<!--
  Invite management for a guild (CREATE_INVITES). The backend createInvite
  already supported expiry + max-uses; this is the missing UI: create a
  configurable shareable link and list / revoke existing active invites.
  The quick "invite a friend" path (InviteToServerSubmenu) is separate.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { toast } from 'svelte-sonner';
  import CopyIcon from '@lucide/svelte/icons/copy';
  import Trash2Icon from '@lucide/svelte/icons/trash-2';
  import { chatApi } from '$lib/api/chat';
  import { inviteLink } from '$lib/guilds/inviteLink';
  import { roles } from '$lib/stores/roles.svelte';
  import { Perm } from '$lib/permissions/bitfield';
  import { Button } from '$lib/components/ui/button/index.js';
  import { Label } from '$lib/components/ui/label/index.js';
  import type { Invite } from '$lib/api/types';
  import { m } from '$lib/paraglide/messages.js';

  let { guildId }: { guildId: string } = $props();

  // Direct add-by-id is a higher-privilege action than creating an invite
  // link (it skips the accept step), so the backend gates it on MANAGE_INVITES.
  const canAddById = $derived(roles.hasGuildPermission(guildId, Perm.MANAGE_INVITES));
  let addUserId = $state('');
  let adding = $state(false);

  async function addById() {
    const id = addUserId.trim();
    if (!id || adding) return;
    adding = true;
    try {
      await chatApi.addMemberById(guildId, id);
      addUserId = '';
      toast.success(m.guild_invites_addbyid_success());
    } catch (e) {
      toast.error(m.guild_invites_addbyid_failed(), {
        description: e instanceof Error ? e.message : String(e)
      });
    } finally {
      adding = false;
    }
  }

  // value = seconds, undefined = never
  const EXPIRY_OPTIONS: { value: number | undefined; label: () => string }[] = [
    { value: 1800, label: () => m.guild_invites_expiry_30m() },
    { value: 3600, label: () => m.guild_invites_expiry_1h() },
    { value: 21600, label: () => m.guild_invites_expiry_6h() },
    { value: 43200, label: () => m.guild_invites_expiry_12h() },
    { value: 86400, label: () => m.guild_invites_expiry_1d() },
    { value: 604800, label: () => m.guild_invites_expiry_7d() },
    { value: undefined, label: () => m.guild_invites_expiry_never() }
  ];
  // value = max uses, undefined = unlimited
  const USES_OPTIONS: { value: number | undefined; label: () => string }[] = [
    { value: 1, label: () => '1' },
    { value: 5, label: () => '5' },
    { value: 10, label: () => '10' },
    { value: 25, label: () => '25' },
    { value: 50, label: () => '50' },
    { value: 100, label: () => '100' },
    { value: undefined, label: () => m.guild_invites_uses_unlimited() }
  ];

  let invites = $state<Invite[]>([]);
  let loading = $state(true);
  let loadError = $state<string | null>(null);
  let creating = $state(false);
  let expiryIdx = $state(4); // 1 day
  let usesIdx = $state(6); // unlimited

  async function load() {
    loading = true;
    loadError = null;
    try {
      invites = await chatApi.listInvites(guildId);
    } catch (e) {
      loadError = e instanceof Error ? e.message : String(e);
    } finally {
      loading = false;
    }
  }

  onMount(load);

  async function copyLink(code: string) {
    try {
      await navigator.clipboard.writeText(inviteLink(code));
      toast.success(m.guild_invites_copied());
    } catch {
      toast.error(m.guild_invites_copy_failed());
    }
  }

  async function create() {
    if (creating) return;
    creating = true;
    try {
      const invite = await chatApi.createInvite(guildId, {
        expiresInSeconds: EXPIRY_OPTIONS[expiryIdx].value,
        maxUses: USES_OPTIONS[usesIdx].value
      });
      invites = [invite, ...invites];
      await copyLink(invite.code);
    } catch (e) {
      toast.error(m.guild_invites_create_failed(), {
        description: e instanceof Error ? e.message : String(e)
      });
    } finally {
      creating = false;
    }
  }

  async function revoke(code: string) {
    try {
      await chatApi.revokeInvite(code);
      invites = invites.filter((i) => i.code !== code);
    } catch (e) {
      toast.error(m.guild_invites_revoke_failed(), {
        description: e instanceof Error ? e.message : String(e)
      });
    }
  }

  function fmtExpiry(iso: string | null): string {
    if (!iso) return m.guild_invites_expiry_never();
    return new Date(iso).toLocaleString('de-DE', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  }

  function fmtUses(inv: Invite): string {
    return inv.max_uses === null ? `${inv.uses} / ∞` : `${inv.uses} / ${inv.max_uses}`;
  }
</script>

<section class="flex flex-col gap-5" data-testid="guild-invites-editor">
  <div>
    <h2 class="text-text-bright text-lg font-semibold">{m.guild_invites_title()}</h2>
    <p class="text-text-muted text-sm">{m.guild_invites_subtitle()}</p>
  </div>

  <!-- Create form -->
  <div class="border-border bg-bg-input/40 flex flex-col gap-3 rounded-2xl border p-4">
    <div class="flex flex-col gap-3 sm:flex-row sm:items-end">
      <div class="flex flex-1 flex-col gap-1.5">
        <Label for="invite-expiry">{m.guild_invites_expire_after()}</Label>
        <select
          id="invite-expiry"
          bind:value={expiryIdx}
          class="bg-bg-input border-border text-text-base w-full rounded-lg border px-3 py-2 text-sm"
          data-testid="invite-expiry"
        >
          {#each EXPIRY_OPTIONS as opt, i (i)}
            <option value={i}>{opt.label()}</option>
          {/each}
        </select>
      </div>
      <div class="flex flex-1 flex-col gap-1.5">
        <Label for="invite-uses">{m.guild_invites_max_uses()}</Label>
        <select
          id="invite-uses"
          bind:value={usesIdx}
          class="bg-bg-input border-border text-text-base w-full rounded-lg border px-3 py-2 text-sm"
          data-testid="invite-uses"
        >
          {#each USES_OPTIONS as opt, i (i)}
            <option value={i}>{opt.label()}</option>
          {/each}
        </select>
      </div>
      <Button onclick={create} disabled={creating} data-testid="invite-create">
        {creating ? m.guild_invites_creating() : m.guild_invites_create()}
      </Button>
    </div>
  </div>

  <!-- Existing invites -->
  {#if loading}
    <p class="text-text-muted text-sm">{m.guild_invites_loading()}</p>
  {:else if loadError}
    <p class="text-destructive text-sm">{loadError}</p>
  {:else if invites.length === 0}
    <p class="text-text-muted text-sm">{m.guild_invites_empty()}</p>
  {:else}
    <ul class="flex flex-col gap-2" data-testid="invite-list">
      {#each invites as inv (inv.code)}
        <li
          class="border-border bg-bg-hover/30 flex items-center gap-3 rounded-xl border p-3"
          data-testid="invite-row"
        >
          <code class="text-text-bright shrink-0 font-mono text-sm">{inv.code}</code>
          <span class="text-text-muted text-xs">{fmtUses(inv)}</span>
          <span class="text-text-muted ml-auto text-xs">{fmtExpiry(inv.expires_at)}</span>
          <button
            type="button"
            class="hover:bg-bg-hover text-text-muted hover:text-text-bright rounded-md p-1.5"
            onclick={() => copyLink(inv.code)}
            title={m.guild_invites_copy_link()}
            data-testid="invite-copy"
          >
            <CopyIcon class="size-4" />
          </button>
          <button
            type="button"
            class="hover:bg-destructive/10 rounded-md p-1.5 text-destructive"
            onclick={() => revoke(inv.code)}
            title={m.guild_invites_revoke()}
            data-testid="invite-revoke"
          >
            <Trash2Icon class="size-4" />
          </button>
        </li>
      {/each}
    </ul>
  {/if}

  {#if canAddById}
    <div class="border-border flex flex-col gap-3 border-t pt-5" data-testid="guild-addbyid">
      <div>
        <h3 class="text-text-bright text-sm font-semibold">{m.guild_invites_addbyid_title()}</h3>
        <p class="text-text-muted text-sm">{m.guild_invites_addbyid_subtitle()}</p>
      </div>
      <div class="flex flex-col gap-3 sm:flex-row sm:items-end">
        <div class="flex flex-1 flex-col gap-1.5">
          <Label for="addbyid-input">{m.guild_invites_addbyid_title()}</Label>
          <input
            id="addbyid-input"
            type="text"
            inputmode="numeric"
            bind:value={addUserId}
            onkeydown={(e) => e.key === 'Enter' && addById()}
            placeholder={m.guild_invites_addbyid_placeholder()}
            class="bg-bg-input border-border text-text-base placeholder:text-text-muted w-full rounded-lg border px-3 py-2 text-sm"
            data-testid="addbyid-input"
          />
        </div>
        <Button
          onclick={addById}
          disabled={adding || addUserId.trim() === ''}
          data-testid="addbyid-submit"
        >
          {adding ? m.guild_invites_addbyid_adding() : m.guild_invites_addbyid_button()}
        </Button>
      </div>
    </div>
  {/if}
</section>
