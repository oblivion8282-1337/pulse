<!--
  Invite-code management. Rendered inside AdminRegistration when the server
  is in ``invite_only`` mode. Lets the admin mint codes (single/multi/unlimited
  use, optional expiry + note), copy a ready-made /register?invite=… link, and
  revoke. Status (Aktiv/Aufgebraucht/Abgelaufen/Widerrufen) is derived client-side.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { toast } from 'svelte-sonner';
  import { Button } from '$lib/components/ui/button/index.js';
  import { Input } from '$lib/components/ui/input/index.js';
  import { Label } from '$lib/components/ui/label/index.js';
  import { adminApi, type Invite } from '$lib/api/admin';
  import { m } from '$lib/paraglide/messages.js';
  import CopyIcon from '@lucide/svelte/icons/copy';
  import Trash2Icon from '@lucide/svelte/icons/trash-2';
  import PlusIcon from '@lucide/svelte/icons/plus';
  import EmptyState from '$lib/components/feedback/EmptyState.svelte';
  import FieldError from '$lib/components/feedback/FieldError.svelte';
  import LoadingState from '$lib/components/feedback/LoadingState.svelte';

  let invites = $state<Invite[]>([]);
  let loading = $state(true);
  let error = $state<string | null>(null);
  let busy = $state(false);

  // Create-form state.
  let unlimited = $state(false);
  let maxUses = $state(1);
  let expiresInDays = $state<number | ''>('');
  let note = $state('');

  onMount(load);

  async function load() {
    loading = true;
    try {
      invites = await adminApi.listInvites();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      loading = false;
    }
  }

  function inviteLink(code: string): string {
    const origin = typeof window !== 'undefined' ? window.location.origin : '';
    return `${origin}/register?invite=${encodeURIComponent(code)}`;
  }

  function status(inv: Invite): { label: string; dead: boolean } {
    if (inv.revoked) return { label: m.admin_registration_invite_status_revoked(), dead: true };
    if (inv.expires_at && new Date(inv.expires_at).getTime() < Date.now())
      return { label: m.admin_registration_invite_status_expired(), dead: true };
    if (inv.max_uses !== null && inv.uses >= inv.max_uses)
      return { label: m.admin_registration_invite_status_exhausted(), dead: true };
    return { label: m.admin_registration_invite_status_active(), dead: false };
  }

  function usesText(inv: Invite): string {
    return inv.max_uses === null ? m.admin_registration_invite_uses_unlimited({ uses: inv.uses }) : `${inv.uses} / ${inv.max_uses}`;
  }

  async function create() {
    if (busy) return;
    busy = true;
    try {
      const inv = await adminApi.createInvite({
        max_uses: unlimited ? null : maxUses,
        expires_in_days: expiresInDays === '' ? null : Number(expiresInDays),
        note: note.trim() || null
      });
      invites = [inv, ...invites];
      note = '';
      await copy(inv.code);
      toast.success(m.admin_registration_invite_toast_created());
    } catch (e) {
      toast.error(m.admin_registration_invite_toast_create_failed(), {
        description: e instanceof Error ? e.message : String(e)
      });
    } finally {
      busy = false;
    }
  }

  async function copy(code: string) {
    try {
      await navigator.clipboard.writeText(inviteLink(code));
      toast.success(m.admin_registration_invite_toast_copied());
    } catch {
      toast.error(m.admin_registration_invite_toast_copy_failed());
    }
  }

  async function revoke(code: string) {
    try {
      await adminApi.revokeInvite(code);
      invites = invites.map((i) => (i.code === code ? { ...i, revoked: true } : i));
    } catch (e) {
      toast.error(m.admin_registration_invite_toast_revoke_failed(), {
        description: e instanceof Error ? e.message : String(e)
      });
    }
  }
</script>

<div class="border-border mt-4 rounded-xl border bg-bg-hover/30 p-4" data-testid="admin-invites">
  <h3 class="text-text-bright text-sm font-semibold">{m.admin_registration_invite_heading()}</h3>
  <p class="text-text-muted mt-0.5 text-xs">
    {m.admin_registration_invite_description()}
  </p>

  <!-- Create form -->
  <div class="mt-3 flex flex-wrap items-end gap-3">
    <div class="space-y-1">
      <Label class="text-text-muted text-xs">{m.admin_registration_invite_label_max_uses()}</Label>
      <div class="flex items-center gap-2">
        <Input
          type="number"
          min="1"
          max="100000"
          bind:value={maxUses}
          disabled={unlimited}
          class="w-24"
          data-testid="invite-max-uses"
        />
        <label class="text-text-muted flex items-center gap-1 text-xs">
          <input type="checkbox" bind:checked={unlimited} class="accent-primary" /> {m.admin_registration_invite_unlimited()}
        </label>
      </div>
    </div>
    <div class="space-y-1">
      <Label class="text-text-muted text-xs">{m.admin_registration_invite_label_expires()}</Label>
      <Input
        type="number"
        min="1"
        max="3650"
        placeholder={m.admin_registration_invite_placeholder_never()}
        bind:value={expiresInDays}
        class="w-24"
        data-testid="invite-expires"
      />
    </div>
    <div class="min-w-40 flex-1 space-y-1">
      <Label class="text-text-muted text-xs">{m.admin_registration_invite_label_note()}</Label>
      <Input bind:value={note} maxlength={100} placeholder={m.admin_registration_invite_placeholder_note()} data-testid="invite-note" />
    </div>
    <Button onclick={create} disabled={busy} data-testid="invite-create">
      <PlusIcon class="size-4" /> {m.admin_registration_invite_btn_create()}
    </Button>
  </div>

  <!-- List -->
  {#if loading}
    <LoadingState label={m.admin_registration_invite_loading()} />
  {:else if error}
    <FieldError message={m.admin_registration_invite_error({ error: error! })} />
  {:else if invites.length === 0}
    <EmptyState message={m.admin_registration_invite_empty()} />
  {:else}
    <ul class="mt-3 flex flex-col gap-1.5">
      {#each invites as inv (inv.code)}
        {@const st = status(inv)}
        <li
          class="border-border flex items-center gap-2 rounded-lg border bg-bg-input px-3 py-2 text-sm"
          data-testid="invite-row"
          class:opacity-50={st.dead}
        >
          <code class="text-text-bright truncate font-mono text-xs">{inv.code}</code>
          <span class="text-text-muted shrink-0 text-xs">{usesText(inv)}</span>
          <span
            class="shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold {st.dead
              ? 'bg-bg-hover text-text-muted'
              : 'bg-success/20 text-success'}"
          >{st.label}</span>
          {#if inv.note}
            <span class="text-text-muted truncate text-xs">· {inv.note}</span>
          {/if}
          <div class="ml-auto flex shrink-0 items-center gap-1">
            <button
              type="button"
              class="text-text-muted hover:text-text-bright rounded p-1"
              title={m.admin_registration_invite_title_copy()}
              onclick={() => copy(inv.code)}
              data-testid="invite-copy"
            >
              <CopyIcon class="size-4" />
            </button>
            {#if !inv.revoked}
              <button
                type="button"
                class="text-text-muted rounded p-1 hover:text-destructive"
                title={m.admin_registration_invite_title_revoke()}
                onclick={() => revoke(inv.code)}
                data-testid="invite-revoke"
              >
                <Trash2Icon class="size-4" />
              </button>
            {/if}
          </div>
        </li>
      {/each}
    </ul>
  {/if}
</div>
