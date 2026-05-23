<!--
  Status-Picker Dropdown.

  Zeigt den aktuellen eigenen Status (aus ``presence.myStatus``) als farbigen
  Dot und öffnet ein Dropdown mit 4 Optionen. Wechsel = REST-Call +
  sofortiger lokaler Store-Update (Server-WS-Echo folgt und ist idempotent).
-->
<script lang="ts">
  import * as DropdownMenu from '$lib/components/ui/dropdown-menu/index.js';
  import StatusDot from '$lib/components/ui/StatusDot.svelte';
  import { presence, type OwnPresenceStatus } from '$lib/stores/presence.svelte';
  import { friendsApi } from '$lib/api/friends';
  import { toast } from 'svelte-sonner';

  type StatusOption = {
    value: OwnPresenceStatus;
    label: string;
    description: string;
  };

  const OPTIONS: StatusOption[] = [
    { value: 'online', label: 'Online', description: 'Du bist sichtbar online' },
    { value: 'idle', label: 'Abwesend', description: 'Als abwesend anzeigen' },
    { value: 'dnd', label: 'Nicht stören', description: 'Notifications werden unterdrückt' },
    { value: 'invisible', label: 'Unsichtbar', description: 'Du erscheinst offline' }
  ];

  let busy = $state(false);

  async function setStatus(next: OwnPresenceStatus) {
    if (busy || next === presence.myStatus) return;
    busy = true;
    // Optimistic update.
    presence.setOwnStatus(next);
    // Persist DND for SW.
    writeDndToIdb(next === 'dnd');
    try {
      await friendsApi.setPresenceStatus(next);
    } catch (e) {
      toast.error('Status konnte nicht gesetzt werden', {
        description: e instanceof Error ? e.message : undefined
      });
    } finally {
      busy = false;
    }
  }

  function writeDndToIdb(dnd: boolean): void {
    try {
      const req = indexedDB.open('pulse_presence', 1);
      req.onupgradeneeded = () => {
        req.result.createObjectStore('status');
      };
      req.onsuccess = () => {
        const db = req.result;
        const tx = db.transaction('status', 'readwrite');
        tx.objectStore('status').put(dnd, 'dnd');
      };
    } catch {
      /* IndexedDB not available (SSR / private mode) — skip */
    }
  }

  let currentLabel = $derived(
    OPTIONS.find((o) => o.value === presence.myStatus)?.label ?? 'Online'
  );
</script>

<DropdownMenu.Root>
  <DropdownMenu.Trigger>
    {#snippet child({ props })}
      <button
        {...props}
        class="hover:bg-bg-hover flex items-center gap-2 rounded-lg px-2 py-1 text-sm transition-colors disabled:opacity-50"
        disabled={busy}
        title="Status ändern"
        data-testid="status-picker-trigger"
        aria-label="Status: {currentLabel}"
      >
        <StatusDot status={presence.myStatus} class="size-3" />
        <span class="text-text-muted text-xs">{currentLabel}</span>
      </button>
    {/snippet}
  </DropdownMenu.Trigger>
  <DropdownMenu.Content side="top" align="start" class="w-52">
    {#each OPTIONS as opt (opt.value)}
      <DropdownMenu.Item
        onclick={() => setStatus(opt.value)}
        data-testid="status-option-{opt.value}"
        class="flex items-center gap-3"
      >
        <StatusDot status={opt.value} class="size-2.5" />
        <div class="flex flex-col">
          <span class="text-text-bright text-sm font-medium">{opt.label}</span>
          <span class="text-text-muted text-xs">{opt.description}</span>
        </div>
        {#if opt.value === presence.myStatus}
          <span class="text-primary ml-auto text-xs">✓</span>
        {/if}
      </DropdownMenu.Item>
    {/each}
  </DropdownMenu.Content>
</DropdownMenu.Root>
