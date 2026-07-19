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
  import { createOverride, excludeEveryone, owKey } from './channelOverrides';
  import { roles as rolesStore } from '$lib/stores/roles.svelte';
  import { userCache } from '$lib/stores/users.svelte';
  import { Perm, has, toBitfield, type Permission } from '$lib/permissions/bitfield';
  import type { Member } from '$lib/api/types';
  import { m } from '$lib/paraglide/messages.js';
  import EmptyState from '$lib/components/feedback/EmptyState.svelte';

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
    { perm: Perm.VIEW_CHANNEL, label: m.channel_overrides_perm_view_channel() },
    { perm: Perm.READ_HISTORY, label: m.channel_overrides_perm_read_history() },
    { perm: Perm.SEND_MESSAGES, label: m.channel_overrides_perm_send_messages() },
    { perm: Perm.MANAGE_MESSAGES, label: m.channel_overrides_perm_manage_messages() },
    { perm: Perm.ATTACH_FILES, label: m.channel_overrides_perm_attach_files() },
    { perm: Perm.ADD_REACTIONS, label: m.channel_overrides_perm_add_reactions() },
    { perm: Perm.CREATE_INVITES, label: m.channel_overrides_perm_create_invites() },
    { perm: Perm.MENTION_EVERYONE, label: m.channel_overrides_perm_mention_everyone() },
    { perm: Perm.MANAGE_CHANNELS, label: m.channel_overrides_perm_manage_channels() },
    { perm: Perm.MANAGE_PERMISSIONS, label: m.channel_overrides_perm_manage_permissions() },
    { perm: Perm.CONNECT, label: m.channel_overrides_perm_connect() },
    { perm: Perm.SPEAK, label: m.channel_overrides_perm_speak() },
    { perm: Perm.STREAM, label: m.channel_overrides_perm_stream() },
    { perm: Perm.USE_VIDEO, label: m.channel_overrides_perm_use_video() }
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
      const k = owKey(ow);
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
      return r ? m.channel_overrides_label_role({ name: r.name }) : m.channel_overrides_label_role_id({ id: ow.target_id });
    }
    const mem = members.find((mem) => mem.user_id === ow.target_id);
    if (mem) return m.channel_overrides_label_member({ name: memberLabel(mem) });
    const cached = userCache.displayName(ow.target_id);
    return m.channel_overrides_label_member({ name: cached });
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
      toast.success(m.channel_overrides_toast_saved());
    } catch (err) {
      toast.error(m.channel_overrides_toast_save_failed(), {
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
          (ow) => owKey(ow) !== target
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
      toast.success(m.channel_overrides_toast_removed());
    } catch (err) {
      toast.error(m.channel_overrides_toast_remove_failed(), {
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
    // Adding a normal role makes the channel exclusive (Discord's
    // private-channel semantics): the role gets VIEW_CHANNEL allow and
    // @everyone gets VIEW_CHANNEL deny — "add a group" means "only this
    // group (and other added targets) can see the channel", with no
    // manual @everyone bookkeeping.
    const everyone = availableRoles.find((r) => r.is_everyone);
    const exclusiveRole =
      targetType === 0 && everyone && targetId !== everyone.id
        ? availableRoles.find((r) => r.id === targetId)
        : undefined;
    try {
      await createOverride(channelId, targetType, targetId, !!exclusiveRole);
      if (exclusiveRole && everyone) {
        const saved = await excludeEveryone(channelId, everyone.id);
        if (saved) {
          // Force-sync the row buffer: the seed-once guard would otherwise
          // keep showing the pre-exclusion state for an already-seeded
          // @everyone row.
          buffers = { ...buffers, [owKey(saved)]: { allow: saved.allow, deny: saved.deny } };
          const nextSeeded = new Set(seededKeys);
          nextSeeded.add(owKey(saved));
          seededKeys = nextSeeded;
        }
      }
      if (targetType === 0) addRoleId = '';
      else addUserId = '';
      if (exclusiveRole) {
        toast.success(m.channel_overrides_toast_added_exclusive({ role: exclusiveRole.name }));
      } else {
        toast.success(m.channel_overrides_toast_added());
      }
    } catch (err) {
      toast.error(m.channel_overrides_toast_add_failed(), {
        description: (err as Error).message
      });
    }
  }

  function memberLabel(m: Member): string {
    return m.nickname ?? userCache.displayName(m.user_id);
  }

  const editorBits = $derived(toBitfield(editorPermissions));

  function isEditorAllowed(perm: Permission): boolean {
    return has(editorBits, perm);
  }
</script>

<div class="space-y-6" data-testid="channel-overrides">
  <header>
    <h2 class="text-text-bright text-base font-semibold">{m.channel_overrides_heading()}</h2>
    <p class="text-text-muted text-sm">
      {m.channel_overrides_order_hint()}
    </p>
  </header>

  <div class="grid gap-3 sm:grid-cols-2">
    <div class="flex flex-wrap items-end gap-2">
      <div class="flex-1">
        <Label for="add-role">{m.channel_overrides_label_role_field()}</Label>
        <select
          id="add-role"
          class="bg-bg-input border-border w-full rounded-md border px-3 py-2 text-sm"
          bind:value={addRoleId}
          data-testid="add-role-select"
        >
          <option value="">{m.channel_overrides_select_role_placeholder()}</option>
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
        {m.channel_overrides_btn_add_role()}
      </Button>
      <p class="text-text-muted basis-full text-xs">{m.channel_overrides_role_add_hint()}</p>
    </div>

    <div class="flex flex-wrap items-end gap-2">
      <div class="flex-1">
        <Label for="add-user">{m.channel_overrides_label_member_field()}</Label>
        <select
          id="add-user"
          class="bg-bg-input border-border w-full rounded-md border px-3 py-2 text-sm"
          bind:value={addUserId}
          data-testid="add-user-select"
        >
          <option value="">{m.channel_overrides_select_member_placeholder()}</option>
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
        {m.channel_overrides_btn_add_member()}
      </Button>
    </div>
  </div>

  {#if overwrites.length === 0}
    <EmptyState message={m.channel_overrides_empty()} />
  {/if}

  {#each overwrites as ow (owKey(ow))}
    {@const key = owKey(ow)}
    <section class="rounded-xl border border-border p-4" data-testid={`override-${key}`}>
      <header class="mb-3 flex items-center justify-between">
        <h3 class="text-text-bright text-sm font-semibold">{labelFor(ow)}</h3>
        <div class="flex gap-2">
          <Button size="sm" onclick={() => save(key)} data-testid={`override-save-${key}`}>
            {m.channel_overrides_btn_save()}
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
