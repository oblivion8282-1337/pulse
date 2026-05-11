<!--
  ServerPicker — Dropdown der ServerProfile aus `gsr_list_profiles`, gemerged
  mit nutzer-definierten Custom-Servern aus dem Settings-Store (T3c).

  Plus „+ Server hinzufügen…" → `AddServerDialog` (T3c), plus Löschen-Knopf
  neben Custom-Einträgen (Builtins sind nicht löschbar).
-->
<script lang="ts">
  import { Button } from '$lib/components/ui/button/index.js';
  import { Label } from '$lib/components/ui/label/index.js';
  import * as Tooltip from '$lib/components/ui/tooltip/index.js';
  import PlusIcon from '@lucide/svelte/icons/plus';
  import Trash2Icon from '@lucide/svelte/icons/trash-2';
  import {
    streamSettings,
    currentServer,
    isCurrentServerCustom,
    removeCustomServer,
    persistSettings,
    type CustomServer,
  } from '../settings.svelte';
  import AddServerDialog from './AddServerDialog.svelte';

  let dialogOpen = $state(false);

  function isCustomEntry(s: { name: string }): boolean {
    return (s as Partial<CustomServer>).is_custom === true;
  }

  function onChange(e: Event) {
    streamSettings.server_name = (e.currentTarget as HTMLSelectElement).value;
    persistSettings();
  }

  function deleteCurrentCustom() {
    const s = currentServer();
    if (!s || !(s as Partial<CustomServer>).is_custom) return;
    if (!confirm(`Server "${s.name}" entfernen?`)) return;
    removeCustomServer(s.name);
  }

  let current = $derived(currentServer());
  let customSelected = $derived(isCurrentServerCustom());
</script>

<div class="flex flex-col gap-1.5" data-testid="stream-server-picker">
  <Label for="stream-server-select">Server</Label>
  <div class="flex items-center gap-2">
    <select
      id="stream-server-select"
      class="bg-bg-input text-text-base h-9 flex-1 rounded-md px-2 text-sm outline-none"
      value={streamSettings.server_name}
      onchange={onChange}
      disabled={streamSettings.available_servers.length === 0}
      data-testid="stream-server-select"
    >
      {#if streamSettings.available_servers.length === 0}
        <option value="">Lade Server…</option>
      {/if}
      {#each streamSettings.available_servers as s (s.name)}
        <option value={s.name}>
          {s.name}{isCustomEntry(s) ? ' (custom)' : ''} · {s.push_protocol}://{s.push_host}:{s.push_port}
        </option>
      {/each}
    </select>

    {#if customSelected}
      <Tooltip.Provider delayDuration={300}>
        <Tooltip.Root>
          <Tooltip.Trigger>
            {#snippet child({ props })}
              <Button
                {...props}
                type="button"
                size="icon"
                variant="ghost"
                onclick={deleteCurrentCustom}
                aria-label="Diesen Custom-Server entfernen"
                data-testid="stream-server-delete"
              >
                <Trash2Icon class="size-4" />
              </Button>
            {/snippet}
          </Tooltip.Trigger>
          <Tooltip.Content>Custom-Server entfernen</Tooltip.Content>
        </Tooltip.Root>
      </Tooltip.Provider>
    {/if}

    <Tooltip.Provider delayDuration={300}>
      <Tooltip.Root>
        <Tooltip.Trigger>
          {#snippet child({ props })}
            <Button
              {...props}
              type="button"
              size="icon"
              variant="ghost"
              onclick={() => (dialogOpen = true)}
              aria-label="Server hinzufügen"
              data-testid="stream-server-add"
            >
              <PlusIcon class="size-4" />
            </Button>
          {/snippet}
        </Tooltip.Trigger>
        <Tooltip.Content>Eigener Server…</Tooltip.Content>
      </Tooltip.Root>
    </Tooltip.Provider>
  </div>

  {#if current}
    <p class="text-text-muted text-xs">
      Pfad: <code class="bg-bg-input rounded px-1">{current.push_path}</code>
      {#if current.needs_auth}· Auth via Stream-Token{/if}
      {#if customSelected}· lokal gespeichert{/if}
    </p>
  {/if}
</div>

<AddServerDialog open={dialogOpen} onClose={() => (dialogOpen = false)} />
