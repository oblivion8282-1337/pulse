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
  import CopyIcon from '@lucide/svelte/icons/copy';
  import Trash2Icon from '@lucide/svelte/icons/trash-2';
  import PlusIcon from '@lucide/svelte/icons/plus';

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
    if (inv.revoked) return { label: 'Widerrufen', dead: true };
    if (inv.expires_at && new Date(inv.expires_at).getTime() < Date.now())
      return { label: 'Abgelaufen', dead: true };
    if (inv.max_uses !== null && inv.uses >= inv.max_uses)
      return { label: 'Aufgebraucht', dead: true };
    return { label: 'Aktiv', dead: false };
  }

  function usesText(inv: Invite): string {
    return inv.max_uses === null ? `${inv.uses} × (unbegrenzt)` : `${inv.uses} / ${inv.max_uses}`;
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
      toast.success('Einladungscode erstellt — Link kopiert');
    } catch (e) {
      toast.error('Erstellen fehlgeschlagen', {
        description: e instanceof Error ? e.message : String(e)
      });
    } finally {
      busy = false;
    }
  }

  async function copy(code: string) {
    try {
      await navigator.clipboard.writeText(inviteLink(code));
      toast.success('Einladungslink kopiert');
    } catch {
      toast.error('Kopieren fehlgeschlagen');
    }
  }

  async function revoke(code: string) {
    try {
      await adminApi.revokeInvite(code);
      invites = invites.map((i) => (i.code === code ? { ...i, revoked: true } : i));
    } catch (e) {
      toast.error('Widerrufen fehlgeschlagen', {
        description: e instanceof Error ? e.message : String(e)
      });
    }
  }
</script>

<div class="border-border mt-4 rounded-xl border bg-bg-hover/30 p-4" data-testid="admin-invites">
  <h3 class="text-text-bright text-sm font-semibold">Einladungscodes</h3>
  <p class="text-text-muted mt-0.5 text-xs">
    Nur im Modus „Nur per Einladung" nötig. Teile den Link — wer ihn öffnet, kann sich registrieren.
  </p>

  <!-- Create form -->
  <div class="mt-3 flex flex-wrap items-end gap-3">
    <div class="space-y-1">
      <Label class="text-text-muted text-xs">Max. Nutzungen</Label>
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
          <input type="checkbox" bind:checked={unlimited} class="accent-primary" /> unbegrenzt
        </label>
      </div>
    </div>
    <div class="space-y-1">
      <Label class="text-text-muted text-xs">Läuft ab in (Tagen)</Label>
      <Input
        type="number"
        min="1"
        max="3650"
        placeholder="nie"
        bind:value={expiresInDays}
        class="w-24"
        data-testid="invite-expires"
      />
    </div>
    <div class="min-w-40 flex-1 space-y-1">
      <Label class="text-text-muted text-xs">Notiz (optional)</Label>
      <Input bind:value={note} maxlength={100} placeholder="z. B. für Max" data-testid="invite-note" />
    </div>
    <Button onclick={create} disabled={busy} data-testid="invite-create">
      <PlusIcon class="size-4" /> Code erstellen
    </Button>
  </div>

  <!-- List -->
  {#if loading}
    <p class="text-text-muted mt-3 text-sm">lade…</p>
  {:else if error}
    <p class="mt-3 text-sm text-red-400">Fehler: {error}</p>
  {:else if invites.length === 0}
    <p class="text-text-muted mt-3 text-sm">Noch keine Codes.</p>
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
              : 'bg-emerald-500/20 text-emerald-400'}"
          >{st.label}</span>
          {#if inv.note}
            <span class="text-text-muted truncate text-xs">· {inv.note}</span>
          {/if}
          <div class="ml-auto flex shrink-0 items-center gap-1">
            <button
              type="button"
              class="text-text-muted hover:text-text-bright rounded p-1"
              title="Einladungslink kopieren"
              onclick={() => copy(inv.code)}
              data-testid="invite-copy"
            >
              <CopyIcon class="size-4" />
            </button>
            {#if !inv.revoked}
              <button
                type="button"
                class="text-text-muted rounded p-1 hover:text-red-400"
                title="Widerrufen"
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
