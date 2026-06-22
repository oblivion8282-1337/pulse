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
  import { m } from '$lib/paraglide/messages.js';

  type StatusOption = {
    value: OwnPresenceStatus;
    label: string;
    description: string;
  };

  const OPTIONS: StatusOption[] = [
    { value: 'online', label: m.status_picker_label_online(), description: m.status_picker_desc_online() },
    { value: 'idle', label: m.status_picker_label_idle(), description: m.status_picker_desc_idle() },
    { value: 'dnd', label: m.status_picker_label_dnd(), description: m.status_picker_desc_dnd() },
    { value: 'invisible', label: m.status_picker_label_invisible(), description: m.status_picker_desc_invisible() }
  ];

  let busy = $state(false);

  async function setStatus(next: OwnPresenceStatus) {
    if (busy || next === presence.myStatus) return;
    busy = true;
    // Optimistische UI-Aktualisierung — bei Fehlschlag zurückrollen, sonst zeigt
    // die UI dauerhaft den falschen Status (kein WS-Echo bei Fehler) bis zum
    // nächsten ready-Frame. writeDndToIdb erst NACH Erfolg, sonst unterdrückt der
    // Service Worker Notifications obwohl der Server den User weiter online führt.
    const prev = presence.myStatus;
    presence.setOwnStatus(next);
    try {
      await friendsApi.setPresenceStatus(next);
      writeDndToIdb(next === 'dnd');
    } catch (e) {
      presence.setOwnStatus(prev);
      writeDndToIdb(prev === 'dnd');
      toast.error(m.status_picker_set_error(), {
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
    OPTIONS.find((o) => o.value === presence.myStatus)?.label ?? m.status_picker_label_online()
  );
</script>

<DropdownMenu.Root>
  <DropdownMenu.Trigger>
    {#snippet child({ props })}
      <button
        {...props}
        class="hover:bg-bg-hover flex items-center gap-2 rounded-lg px-2 py-1 text-sm transition-colors disabled:opacity-50"
        disabled={busy}
        title={m.status_picker_change_title()}
        data-testid="status-picker-trigger"
        aria-label={m.status_picker_aria_label({ currentLabel })}
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
