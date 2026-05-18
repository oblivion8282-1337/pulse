<!--
  ChannelOverridesEditor — per-channel allow/deny overwrites.

  Discord-style three-state toggle per permission: Allow (allow bit set),
  Deny (deny bit set), Neutral (neither). Operates over an arbitrary
  number of targets — roles + users. Backend enforces anti-escalation
  (editor must hold every bit they grant or un-deny) independently of
  this UI, which only locks toggles for visual feedback.
-->
<script lang="ts">
  import { Button } from '$lib/components/ui/button/index.js';
  import { Label } from '$lib/components/ui/label/index.js';
  import PlusIcon from '@lucide/svelte/icons/plus';
  import TrashIcon from '@lucide/svelte/icons/trash-2';
  import { onMount } from 'svelte';
  import { toast } from 'svelte-sonner';
  import { chatApi } from '$lib/api/chat';
  import { overwritesApi, type Overwrite } from '$lib/api/roles';
  import { channelPermissions } from '$lib/stores/channelPermissions.svelte';
  import { roles as rolesStore } from '$lib/stores/roles.svelte';
  import { userCache } from '$lib/stores/users.svelte';
  import { Perm, has, toBitfield, type Permission } from '$lib/permissions/bitfield';
  import type { Member } from '$lib/api/types';

  let {
    channelId,
    guildId,
    editorPermissions
  }: { channelId: string; guildId: string; editorPermissions: string } = $props();

  type Triple = 'allow' | 'neutral' | 'deny';

  type GridEntry = { perm: Permission; label: string };

  // Compact list of editable bits — matches PermissionToggleGrid order
  // but keeps the per-channel scope (we omit server-admin / member-admin
  // bits that don't apply at channel scope; they're guild-wide).
  const channelBits: GridEntry[] = [
    { perm: Perm.VIEW_CHANNEL, label: 'Kanal ansehen' },
    { perm: Perm.READ_HISTORY, label: 'Verlauf lesen' },
    { perm: Perm.SEND_MESSAGES, label: 'Nachrichten senden' },
    { perm: Perm.MANAGE_MESSAGES, label: 'Nachrichten moderieren' },
    { perm: Perm.ATTACH_FILES, label: 'Dateien anhängen' },
    { perm: Perm.ADD_REACTIONS, label: 'Reaktionen' },
    { perm: Perm.CREATE_INVITES, label: 'Einladungen erstellen' },
    { perm: Perm.MENTION_EVERYONE, label: '@everyone erwähnen' },
    { perm: Perm.MANAGE_CHANNELS, label: 'Kanal verwalten' },
    { perm: Perm.MANAGE_PERMISSIONS, label: 'Berechtigungen' },
    { perm: Perm.CONNECT, label: 'Voice betreten' },
    { perm: Perm.SPEAK, label: 'Sprechen' },
    { perm: Perm.STREAM, label: 'Stream / Screenshare' },
    { perm: Perm.USE_VIDEO, label: 'Kamera' }
  ];

  let overwrites = $derived<Overwrite[]>(channelPermissions.byChannel[channelId] ?? []);
  let availableRoles = $derived(rolesStore.byGuild[guildId] ?? []);

  // Map target → cached editor buffer (allow/deny). Stored as strings
  // so the toggles can flip bits without floating bigints into reactive
  // state. We only snapshot a (target_type, target_id) the *first* time
  // it lands — re-seeding on every reactive run would silently revert
  // in-progress edits on rows the user hasn't saved yet (mirrors the
  // ``lastLoadedId`` pattern in RolesEditor). WS events from other
  // editors come through `channelPermissions.apply` and re-render the
  // row, but the local buffer is left alone — the user has to save or
  // explicitly discard to pick up remote changes.
  let buffers = $state<Record<string, { allow: string; deny: string }>>({});
  let seededKeys = $state<Set<string>>(new Set());

  $effect(() => {
    let next = buffers;
    let nextSeeded = seededKeys;
    let mutated = false;
    for (const ow of overwrites) {
      const k = `${ow.target_type}:${ow.target_id}`;
      if (nextSeeded.has(k)) continue;
      if (!mutated) {
        next = { ...buffers };
        nextSeeded = new Set(seededKeys);
        mutated = true;
      }
      next[k] = { allow: ow.allow, deny: ow.deny };
      nextSeeded.add(k);
    }
    if (mutated) {
      buffers = next;
      seededKeys = nextSeeded;
    }
  });

  function tripleFor(target: string, perm: Permission): Triple {
    const b = buffers[target];
    if (!b) return 'neutral';
    if (has(toBitfield(b.allow), perm)) return 'allow';
    if (has(toBitfield(b.deny), perm)) return 'deny';
    return 'neutral';
  }

  function flip(target: string, perm: Permission, to: Triple): void {
    const b = buffers[target] ?? { allow: '0', deny: '0' };
    let allow = toBitfield(b.allow);
    let deny = toBitfield(b.deny);
    allow &= ~perm;
    deny &= ~perm;
    if (to === 'allow') allow |= perm;
    if (to === 'deny') deny |= perm;
    buffers = { ...buffers, [target]: { allow: allow.toString(), deny: deny.toString() } };
  }

  function labelFor(ow: Overwrite | { target_type: 0 | 1; target_id: string }): string {
    if (ow.target_type === 0) {
      const r = availableRoles.find((r) => r.id === ow.target_id);
      return r ? `Rolle: ${r.name}` : `Rolle ${ow.target_id}`;
    }
    const m = members.find((m) => m.user_id === ow.target_id);
    if (m) return `Mitglied: ${memberLabel(m)}`;
    const cached = userCache.displayName(ow.target_id);
    return `Mitglied: ${cached}`;
  }

  async function save(target: string): Promise<void> {
    const [tt, tid] = target.split(':');
    const b = buffers[target];
    if (!b) return;
    try {
      await overwritesApi.set(channelId, Number(tt) as 0 | 1, tid, {
        allow: b.allow,
        deny: b.deny
      });
      toast.success('Override gespeichert');
    } catch (err) {
      toast.error('Override speichern fehlgeschlagen', {
        description: (err as Error).message
      });
    }
  }

  async function remove(target: string): Promise<void> {
    const [tt, tid] = target.split(':');
    try {
      await overwritesApi.delete(channelId, Number(tt) as 0 | 1, tid);
      channelPermissions.apply(
        channelId,
        (channelPermissions.byChannel[channelId] ?? []).filter(
          (ow) => `${ow.target_type}:${ow.target_id}` !== target
        )
      );
      // Forget the seed-once guard for this row so adding the same
      // target again later re-snapshots the server's reset values.
      if (seededKeys.has(target)) {
        const nextSeeded = new Set(seededKeys);
        nextSeeded.delete(target);
        seededKeys = nextSeeded;
        const nextBuffers = { ...buffers };
        delete nextBuffers[target];
        buffers = nextBuffers;
      }
      toast.success('Override entfernt');
    } catch (err) {
      toast.error('Override entfernen fehlgeschlagen', {
        description: (err as Error).message
      });
    }
  }

  let addRoleId = $state('');
  let addUserId = $state('');
  let members = $state<Member[]>([]);

  onMount(async () => {
    try {
      members = await chatApi.listMembers(guildId);
      for (const m of members) userCache.queue(m.user_id);
    } catch {
      members = [];
    }
  });

  async function addOverride(targetType: 0 | 1, targetId: string): Promise<void> {
    if (!targetId) return;
    try {
      const created = await overwritesApi.set(channelId, targetType, targetId, {
        allow: '0',
        deny: '0'
      });
      // Push the new row into the cache immediately — without this the
      // overwrite list only repaints after the WS broadcast lands, which
      // makes the UI feel laggy on slow links.
      const current = channelPermissions.byChannel[channelId] ?? [];
      const exists = current.some(
        (ow) => ow.target_type === created.target_type && ow.target_id === created.target_id
      );
      channelPermissions.apply(
        channelId,
        exists
          ? current.map((ow) =>
              ow.target_type === created.target_type && ow.target_id === created.target_id
                ? created
                : ow
            )
          : [...current, created]
      );
      if (targetType === 0) addRoleId = '';
      else addUserId = '';
      toast.success('Override hinzugefügt');
    } catch (err) {
      toast.error('Override hinzufügen fehlgeschlagen', {
        description: (err as Error).message
      });
    }
  }

  function memberLabel(m: Member): string {
    return m.nickname ?? userCache.displayName(m.user_id);
  }

  function isEditorAllowed(perm: Permission): boolean {
    return has(toBitfield(editorPermissions), perm);
  }
</script>

<div class="space-y-6" data-testid="channel-overrides">
  <header>
    <h2 class="text-text-bright text-base font-semibold">Kanal-Berechtigungen</h2>
    <p class="text-text-muted text-sm">
      Override-Reihenfolge: @everyone-Channel-Override → Rollen-Overrides
      (nach Position) → User-Override. Wenn am Ende VIEW fehlt, sind alle
      anderen Bits irrelevant — der Server stellt das hart sicher.
    </p>
  </header>

  <div class="grid gap-3 sm:grid-cols-2">
    <div class="flex flex-wrap items-end gap-2">
      <div class="flex-1">
        <Label for="add-role">Rolle</Label>
        <select
          id="add-role"
          class="bg-bg-input border-border w-full rounded-md border px-3 py-2 text-sm"
          bind:value={addRoleId}
          data-testid="add-role-select"
        >
          <option value="">— Rolle wählen —</option>
          {#each availableRoles as r (r.id)}
            {@const already = overwrites.some(
              (ow) => ow.target_type === 0 && ow.target_id === r.id
            )}
            {#if !already}
              <option value={r.id}>{r.name}{r.is_everyone ? ' (@everyone)' : ''}</option>
            {/if}
          {/each}
        </select>
      </div>
      <Button onclick={() => addOverride(0, addRoleId)} disabled={!addRoleId} data-testid="add-role-btn">
        <PlusIcon />
        Rolle
      </Button>
    </div>

    <div class="flex flex-wrap items-end gap-2">
      <div class="flex-1">
        <Label for="add-user">Mitglied</Label>
        <select
          id="add-user"
          class="bg-bg-input border-border w-full rounded-md border px-3 py-2 text-sm"
          bind:value={addUserId}
          data-testid="add-user-select"
        >
          <option value="">— Mitglied wählen —</option>
          {#each members as m (m.user_id)}
            {@const already = overwrites.some(
              (ow) => ow.target_type === 1 && ow.target_id === m.user_id
            )}
            {#if !already}
              <option value={m.user_id}>{memberLabel(m)}</option>
            {/if}
          {/each}
        </select>
      </div>
      <Button onclick={() => addOverride(1, addUserId)} disabled={!addUserId} data-testid="add-user-btn">
        <PlusIcon />
        User
      </Button>
    </div>
  </div>

  {#if overwrites.length === 0}
    <p class="text-text-muted rounded-lg border border-dashed border-border p-4 text-sm">
      Keine Overrides — der Kanal nutzt die Server-Defaults.
    </p>
  {/if}

  {#each overwrites as ow (ow.target_type + ':' + ow.target_id)}
    {@const key = `${ow.target_type}:${ow.target_id}`}
    <section class="rounded-lg border border-border p-4" data-testid={`override-${key}`}>
      <header class="mb-3 flex items-center justify-between">
        <h3 class="text-text-bright text-sm font-semibold">{labelFor(ow)}</h3>
        <div class="flex gap-2">
          <Button size="sm" onclick={() => save(key)} data-testid={`override-save-${key}`}>
            Speichern
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onclick={() => remove(key)}
            data-testid={`override-delete-${key}`}
          >
            <TrashIcon />
          </Button>
        </div>
      </header>
      <ul class="divide-border divide-y">
        {#each channelBits as b (b.perm)}
          {@const s = tripleFor(key, b.perm)}
          {@const allowed = isEditorAllowed(b.perm)}
          <li class="flex items-center justify-between py-1.5">
            <span class="text-sm" class:opacity-50={!allowed}>{b.label}</span>
            <div class="flex gap-1">
              {#each [
                { v: 'deny', cls: 'text-red-400 hover:bg-red-500/15', sel: 'bg-red-500/20 text-red-300', icon: '✕' },
                { v: 'neutral', cls: 'text-text-muted hover:bg-bg-hover', sel: 'bg-bg-hover text-text-bright', icon: '/' },
                { v: 'allow', cls: 'text-green-400 hover:bg-green-500/15', sel: 'bg-green-500/20 text-green-300', icon: '✓' }
              ] as opt (opt.v)}
                <button
                  type="button"
                  class={`size-7 rounded-md font-mono text-xs transition-colors ${s === opt.v ? opt.sel : opt.cls}`}
                  onclick={() => flip(key, b.perm, opt.v as Triple)}
                  disabled={!allowed}
                  aria-pressed={s === opt.v}
                  aria-label={opt.v}
                  data-testid={`override-toggle-${key}-${b.perm}-${opt.v}`}
                >{opt.icon}</button>
              {/each}
            </div>
          </li>
        {/each}
      </ul>
    </section>
  {/each}
</div>
