<!--
  RolesEditor — list + per-role editor for a guild's roles. Used by the
  guild-settings page; backend gate is MANAGE_ROLES, which the parent
  enforces before mounting.

  Anti-escalation is mirrored client-side in PermissionToggleGrid: bits
  the editor doesn't hold themselves are locked off. The server enforces
  it independently (the UI block is a UX nicety, not security).
-->
<script lang="ts">
  import { Button } from '$lib/components/ui/button/index.js';
  import * as AlertDialog from '$lib/components/ui/alert-dialog/index.js';
  import { Input } from '$lib/components/ui/input/index.js';
  import { Label } from '$lib/components/ui/label/index.js';
  import PlusIcon from '@lucide/svelte/icons/plus';
  import TrashIcon from '@lucide/svelte/icons/trash-2';
  import { toast } from 'svelte-sonner';
  import { rolesApi, type Role } from '$lib/api/roles';
  import { roles as rolesStore } from '$lib/stores/roles.svelte';
  import PermissionToggleGrid from './PermissionToggleGrid.svelte';

  let { guildId, editorPermissions }: { guildId: string; editorPermissions: string } = $props();

  let allRoles = $derived(rolesStore.byGuild[guildId] ?? []);
  let sortedRoles = $derived(
    [...allRoles].sort((a, b) =>
      a.is_everyone === b.is_everyone ? b.position - a.position : a.is_everyone ? 1 : -1
    )
  );
  let selectedId = $state<string | null>(null);
  let selectedRole = $derived(sortedRoles.find((r) => r.id === selectedId) ?? sortedRoles[0]);

  // Local edit buffer — the user changes name/permissions/color before
  // hitting Save. Cancel reverts. Saved on PATCH success.
  let editName = $state('');
  let editPermissions = $state('0');
  let editHoist = $state(false);
  let editMentionable = $state(false);
  let isSaving = $state(false);
  let deleteConfirm = $state(false);

  // Mirror the selected role into the buffer whenever the selection
  // changes (and on first mount).
  $effect(() => {
    if (selectedRole) {
      editName = selectedRole.name;
      editPermissions = selectedRole.permissions;
      editHoist = selectedRole.hoist;
      editMentionable = selectedRole.mentionable;
    }
  });

  async function createRole(): Promise<void> {
    try {
      const r = await rolesApi.create(guildId, { name: 'Neue Rolle', permissions: '0' });
      rolesStore.upsertRole(r);
      selectedId = r.id;
      toast.success('Rolle erstellt');
    } catch (err) {
      toast.error('Rolle erstellen fehlgeschlagen', { description: (err as Error).message });
    }
  }

  async function saveRole(): Promise<void> {
    if (!selectedRole) return;
    isSaving = true;
    try {
      const r = await rolesApi.patch(guildId, selectedRole.id, {
        name: selectedRole.is_everyone ? undefined : editName,
        permissions: editPermissions,
        hoist: editHoist,
        mentionable: editMentionable
      });
      rolesStore.upsertRole(r);
      toast.success('Rolle gespeichert');
    } catch (err) {
      toast.error('Speichern fehlgeschlagen', { description: (err as Error).message });
    } finally {
      isSaving = false;
    }
  }

  async function deleteRole(): Promise<void> {
    if (!selectedRole || selectedRole.is_everyone) return;
    try {
      await rolesApi.delete(guildId, selectedRole.id);
      rolesStore.removeRole(guildId, selectedRole.id);
      selectedId = null;
      deleteConfirm = false;
      toast.success('Rolle gelöscht');
    } catch (err) {
      toast.error('Löschen fehlgeschlagen', { description: (err as Error).message });
    }
  }
</script>

<div class="flex h-full min-h-0 flex-col gap-4 md:flex-row" data-testid="roles-editor">
  <aside class="w-full shrink-0 md:w-64">
    <div class="mb-2 flex items-center justify-between">
      <h2 class="text-text-bright text-sm font-semibold">Rollen</h2>
      <Button size="icon-sm" variant="ghost" onclick={createRole} data-testid="role-create">
        <PlusIcon />
      </Button>
    </div>
    <ul class="space-y-1">
      {#each sortedRoles as r (r.id)}
        <li>
          <button
            type="button"
            class="hover:bg-bg-hover w-full rounded-lg px-3 py-2 text-left text-sm transition-colors"
            class:bg-bg-hover={selectedId === r.id}
            onclick={() => (selectedId = r.id)}
            data-testid={`role-row-${r.id}`}
          >
            <span class="font-medium" style={r.color ? `color: #${r.color.toString(16).padStart(6, '0')}` : ''}>
              {r.name}
            </span>
            {#if r.is_everyone}<span class="text-text-muted ml-1 text-xs">(implizit)</span>{/if}
          </button>
        </li>
      {/each}
    </ul>
  </aside>

  <section class="min-w-0 flex-1 overflow-y-auto">
    {#if selectedRole}
      <div class="mb-4 flex items-end justify-between gap-3">
        <div class="min-w-0 flex-1 space-y-2">
          <Label for="role-name">Name</Label>
          <Input
            id="role-name"
            bind:value={editName}
            disabled={selectedRole.is_everyone}
            data-testid="role-name-input"
          />
          {#if selectedRole.is_everyone}
            <p class="text-text-muted text-xs">@everyone kann nicht umbenannt werden.</p>
          {/if}
        </div>
        {#if !selectedRole.is_everyone}
          <Button
            variant="ghost"
            size="sm"
            onclick={() => (deleteConfirm = true)}
            data-testid="role-delete-btn"
          >
            <TrashIcon /> Löschen
          </Button>
        {/if}
      </div>

      <div class="mb-4 flex flex-wrap gap-4">
        <label class="flex items-center gap-2 text-sm">
          <input type="checkbox" bind:checked={editHoist} class="size-4 accent-primary" />
          In Member-Liste hervorheben
        </label>
        <label class="flex items-center gap-2 text-sm">
          <input type="checkbox" bind:checked={editMentionable} class="size-4 accent-primary" />
          Erwähnbar (@&lt;rolle&gt;)
        </label>
      </div>

      <PermissionToggleGrid bind:value={editPermissions} {editorPermissions} disabled={isSaving} />

      <div class="mt-6 flex justify-end gap-2">
        <Button onclick={saveRole} disabled={isSaving} data-testid="role-save">
          {isSaving ? 'Speichert…' : 'Speichern'}
        </Button>
      </div>
    {:else}
      <p class="text-text-muted text-sm">Wähle eine Rolle aus oder erstelle eine neue.</p>
    {/if}
  </section>
</div>

<AlertDialog.Root bind:open={deleteConfirm}>
  <AlertDialog.Content>
    <AlertDialog.Header>
      <AlertDialog.Title>Rolle löschen?</AlertDialog.Title>
      <AlertDialog.Description>
        {selectedRole?.name} wird entfernt und allen Mitgliedern entzogen.
      </AlertDialog.Description>
    </AlertDialog.Header>
    <AlertDialog.Footer>
      <AlertDialog.Cancel>Abbrechen</AlertDialog.Cancel>
      <AlertDialog.Action onclick={deleteRole}>Löschen</AlertDialog.Action>
    </AlertDialog.Footer>
  </AlertDialog.Content>
</AlertDialog.Root>
