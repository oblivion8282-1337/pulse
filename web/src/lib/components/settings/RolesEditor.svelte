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
  import ChevronUpIcon from '@lucide/svelte/icons/chevron-up';
  import ChevronDownIcon from '@lucide/svelte/icons/chevron-down';
  import { toast } from 'svelte-sonner';
  import { rolesApi, type Role } from '$lib/api/roles';
  import { roles as rolesStore } from '$lib/stores/roles.svelte';
  import PermissionToggleGrid from './PermissionToggleGrid.svelte';

  let {
    guildId,
    editorPermissions,
    discardSignal = 0,
    dirty = $bindable(false)
  }: {
    guildId: string;
    editorPermissions: string;
    /** Monotonic counter bumped by the parent to force a buffer-discard
     * (tab-switch / close confirms). We can't just rely on the parent
     * clearing `dirty` because our own dirty-effect re-derives it from
     * buffer ≠ persisted role on the next tick. */
    discardSignal?: number;
    /** Reflects whether the buffer differs from the saved role. The
     * parent (settings dialog) reads this to gate the close-confirm. */
    dirty?: boolean;
  } = $props();

  let allRoles = $derived(rolesStore.byGuild[guildId] ?? []);
  let sortedRoles = $derived(
    [...allRoles].sort((a, b) =>
      a.is_everyone === b.is_everyone ? b.position - a.position : a.is_everyone ? 1 : -1
    )
  );
  let selectedId = $state<string | null>(null);
  let selectedRole = $derived(sortedRoles.find((r) => r.id === selectedId) ?? sortedRoles[0]);

  // Drag-and-drop position state. dragId is the role being moved; dragOver
  // is the role we'd insert *before*. @everyone is fixed at position 0
  // and neither draggable nor a drop target.
  let dragId = $state<string | null>(null);
  let dragOverId = $state<string | null>(null);

  function onDragStart(e: DragEvent, id: string): void {
    if (!e.dataTransfer) return;
    dragId = id;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', id);
  }

  function onDragOver(e: DragEvent, id: string): void {
    if (!dragId || dragId === id) return;
    e.preventDefault();
    dragOverId = id;
  }

  /** Push the new order to the server. Top-of-list = highest position
   * so the visual order matches Discord's "highest role = top" mental
   * model. Both onDrop and move() funnel through here. */
  async function commitOrder(reordered: Role[]): Promise<void> {
    const updates = reordered.map((r, i) => ({
      id: r.id,
      position: reordered.length - i
    }));
    try {
      const rows = await rolesApi.setPositions(guildId, updates);
      for (const r of rows) rolesStore.upsertRole(r);
    } catch (err) {
      toast.error('Reihenfolge ändern fehlgeschlagen', { description: (err as Error).message });
    }
  }

  async function onDrop(e: DragEvent, targetId: string): Promise<void> {
    e.preventDefault();
    const sourceId = dragId;
    dragId = null;
    dragOverId = null;
    if (!sourceId || sourceId === targetId) return;
    const nonEveryone = sortedRoles.filter((r) => !r.is_everyone);
    const fromIdx = nonEveryone.findIndex((r) => r.id === sourceId);
    const toIdx = nonEveryone.findIndex((r) => r.id === targetId);
    if (fromIdx < 0 || toIdx < 0) return;
    const reordered = [...nonEveryone];
    const [moved] = reordered.splice(fromIdx, 1);
    reordered.splice(toIdx, 0, moved);
    await commitOrder(reordered);
  }

  /** Move a role one slot up (-1) or down (+1) in the visual list.
   * Used by the touch/keyboard fallback buttons — drag-and-drop is
   * still the primary path on desktop. @everyone is locked at the
   * bottom; swaps that would cross it are no-ops. */
  async function move(roleId: string, direction: -1 | 1): Promise<void> {
    const nonEveryone = sortedRoles.filter((r) => !r.is_everyone);
    const idx = nonEveryone.findIndex((r) => r.id === roleId);
    if (idx < 0) return;
    const target = idx + direction;
    if (target < 0 || target >= nonEveryone.length) return;
    const reordered = [...nonEveryone];
    [reordered[idx], reordered[target]] = [reordered[target], reordered[idx]];
    await commitOrder(reordered);
  }

  // Local edit buffer — the user changes name/permissions/color before
  // hitting Save. Cancel reverts. Saved on PATCH success.
  let editName = $state('');
  let editPermissions = $state('0');
  let editColor = $state<string>('#9ca3af'); // gray-400, matches "no colour" default
  let editColorEnabled = $state(false);
  let editHoist = $state(false);
  let editMentionable = $state(false);
  let isSaving = $state(false);
  let deleteConfirm = $state(false);

  // Mirror the selected role into the buffer. We *can't* use $effect for
  // this safely because that would constantly reset the user's pending
  // edits whenever WS pushes a role_updated for the very role we're
  // editing. Instead we snapshot manually on switch + after save.
  function loadIntoBuffer(r: Role | undefined): void {
    if (!r) return;
    editName = r.name;
    editPermissions = r.permissions;
    editColorEnabled = r.color != null;
    editColor = r.color != null
      ? '#' + r.color.toString(16).padStart(6, '0')
      : '#9ca3af';
    editHoist = r.hoist;
    editMentionable = r.mentionable;
  }

  // Initial load + auto-load on role-list arrival (when no selection yet).
  let lastLoadedId = $state<string | null>(null);
  $effect(() => {
    if (selectedRole && selectedRole.id !== lastLoadedId) {
      // Only reload when we just switched to a *different* role;
      // don't trample the buffer on re-render of the same selection.
      loadIntoBuffer(selectedRole);
      lastLoadedId = selectedRole.id;
    }
  });

  // Dirty = buffer differs from the persisted role. Drives the
  // "Verwerfen / Speichern"-bar + the parent's close-confirm.
  $effect(() => {
    if (!selectedRole) {
      dirty = false;
      return;
    }
    const currentColour = editColorEnabled
      ? parseInt(editColor.replace('#', ''), 16)
      : null;
    dirty =
      editName !== selectedRole.name ||
      editPermissions !== selectedRole.permissions ||
      currentColour !== selectedRole.color ||
      editHoist !== selectedRole.hoist ||
      editMentionable !== selectedRole.mentionable;
  });

  let pendingSwitchId = $state<string | null>(null);
  let switchConfirmOpen = $state(false);

  function trySelect(id: string): void {
    if (id === selectedId) return;
    if (dirty) {
      pendingSwitchId = id;
      switchConfirmOpen = true;
      return;
    }
    selectedId = id;
  }

  function confirmDiscardAndSwitch(): void {
    if (pendingSwitchId) {
      selectedId = pendingSwitchId;
      pendingSwitchId = null;
    }
    switchConfirmOpen = false;
  }

  function discardEdits(): void {
    if (selectedRole) loadIntoBuffer(selectedRole);
  }

  // Parent-driven discard (tab-switch / close confirm). The initial
  // value is captured on mount via untrack so subsequent changes from
  // the parent trigger the reset.
  let lastDiscardSignal = $state(0);
  $effect(() => {
    const sig = discardSignal;
    if (sig !== lastDiscardSignal) {
      lastDiscardSignal = sig;
      discardEdits();
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
      // ``color: null`` clears the colour (members fall back to default
      // text colour). HTML's <input type="color"> only emits "#rrggbb"
      // strings; parse to int once before the PATCH.
      const colourInt = editColorEnabled
        ? parseInt(editColor.replace('#', ''), 16)
        : null;
      const r = await rolesApi.patch(guildId, selectedRole.id, {
        name: selectedRole.is_everyone ? undefined : editName,
        permissions: editPermissions,
        color: colourInt,
        hoist: editHoist,
        mentionable: editMentionable
      });
      rolesStore.upsertRole(r);
      // Re-snapshot so dirty flips back to false. Without this the new
      // role state from upsertRole would race with the buffer.
      loadIntoBuffer(r);
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
      {#each sortedRoles as r, idx (r.id)}
        {@const nonEveryoneList = sortedRoles.filter((x) => !x.is_everyone)}
        {@const localIdx = nonEveryoneList.findIndex((x) => x.id === r.id)}
        {@const isFirst = localIdx === 0}
        {@const isLast = localIdx === nonEveryoneList.length - 1}
        <li
          draggable={!r.is_everyone}
          ondragstart={(e) => !r.is_everyone && onDragStart(e, r.id)}
          ondragover={(e) => !r.is_everyone && onDragOver(e, r.id)}
          ondragleave={() => (dragOverId = null)}
          ondrop={(e) => !r.is_everyone && onDrop(e, r.id)}
          class="flex items-center gap-1 rounded-lg pr-1 transition-shadow"
          class:ring-2={dragOverId === r.id}
          class:ring-primary={dragOverId === r.id}
          class:opacity-50={dragId === r.id}
          data-testid={`role-row-${r.id}`}
        >
          <button
            type="button"
            class="hover:bg-bg-hover flex-1 rounded-lg px-3 py-2 text-left text-sm transition-colors"
            class:bg-bg-hover={selectedId === r.id}
            onclick={() => trySelect(r.id)}
          >
            <span class="font-medium" style={r.color ? `color: #${r.color.toString(16).padStart(6, '0')}` : ''}>
              {r.name}
            </span>
            {#if r.is_everyone}<span class="text-text-muted ml-1 text-xs">(implizit)</span>{/if}
          </button>
          {#if !r.is_everyone}
            <div class="flex flex-col">
              <button
                type="button"
                class="hover:bg-bg-hover rounded p-0.5 disabled:opacity-30"
                disabled={isFirst}
                onclick={() => move(r.id, -1)}
                aria-label="Eine Position höher"
                data-testid={`role-move-up-${r.id}`}
              >
                <ChevronUpIcon class="size-3" />
              </button>
              <button
                type="button"
                class="hover:bg-bg-hover rounded p-0.5 disabled:opacity-30"
                disabled={isLast}
                onclick={() => move(r.id, 1)}
                aria-label="Eine Position tiefer"
                data-testid={`role-move-down-${r.id}`}
              >
                <ChevronDownIcon class="size-3" />
              </button>
            </div>
          {/if}
        </li>
      {/each}
    </ul>
    <p class="text-text-muted mt-2 text-xs">
      Ziehen oder mit Pfeil-Buttons umordnen. Obere Position = mächtigere Rolle.
    </p>
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

      <div class="mb-4 space-y-2">
        <Label>Farbe</Label>
        <div class="flex items-center gap-3">
          <label class="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              bind:checked={editColorEnabled}
              class="size-4 accent-primary"
              data-testid="role-color-enabled"
            />
            Farbe verwenden
          </label>
          <input
            type="color"
            bind:value={editColor}
            disabled={!editColorEnabled}
            class="h-8 w-16 cursor-pointer rounded border border-border bg-transparent disabled:opacity-40"
            data-testid="role-color-input"
            aria-label="Farbe wählen"
          />
          <span
            class="text-sm font-medium"
            style={editColorEnabled ? `color: ${editColor}` : ''}
          >
            {editName || 'Rollenname'}
          </span>
        </div>
        <p class="text-text-muted text-xs">
          Member werden in dieser Farbe in der Mitglieder-Liste angezeigt
          (höchste positionierte Color-Rolle gewinnt).
        </p>
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

      <div class="mt-6 flex items-center justify-between gap-2 rounded-lg border border-border bg-bg-input/60 px-3 py-2">
        <span class="text-text-muted text-xs">
          {dirty ? 'Ungespeicherte Änderungen.' : 'Keine Änderungen.'}
        </span>
        <div class="flex gap-2">
          <Button
            variant="ghost"
            size="sm"
            onclick={discardEdits}
            disabled={!dirty || isSaving}
            data-testid="role-discard"
          >
            Verwerfen
          </Button>
          <Button
            onclick={saveRole}
            disabled={!dirty || isSaving}
            data-testid="role-save"
          >
            {isSaving ? 'Speichert…' : 'Speichern'}
          </Button>
        </div>
      </div>
    {:else}
      <p class="text-text-muted text-sm">Wähle eine Rolle aus oder erstelle eine neue.</p>
    {/if}
  </section>
</div>

<AlertDialog.Root bind:open={switchConfirmOpen}>
  <AlertDialog.Content data-testid="role-switch-confirm">
    <AlertDialog.Header>
      <AlertDialog.Title>Ungespeicherte Änderungen verwerfen?</AlertDialog.Title>
      <AlertDialog.Description>
        Du hast Änderungen an {selectedRole?.name ?? 'dieser Rolle'}, die noch
        nicht gespeichert sind. Beim Wechsel gehen sie verloren.
      </AlertDialog.Description>
    </AlertDialog.Header>
    <AlertDialog.Footer>
      <AlertDialog.Cancel>Abbrechen</AlertDialog.Cancel>
      <AlertDialog.Action onclick={confirmDiscardAndSwitch}>Verwerfen</AlertDialog.Action>
    </AlertDialog.Footer>
  </AlertDialog.Content>
</AlertDialog.Root>

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
