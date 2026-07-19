<!--
  StreamPickerDialog — global chooser shown when a user runs more than one HQ
  stream and a viewer clicks their LIVE badge. Mounted once in the app layout;
  driven by the `streamPicker` store. Single-stream clicks never open this (they
  open directly) — see lib/stream/hqTile.ts::chooseHqForUser. Mirrors
  WatchPartyPickerDialog 1:1, plus an "Alle ansehen" entry.

  The viewer doesn't know each stream's capture-source type (no GSR catalogs on
  the receiving side), so a fixed monitor icon is used; the descriptive label
  (from stream_state, e.g. "Monitor 1" / "Chrome") carries the distinction.
-->
<script lang="ts">
  import * as Dialog from '$lib/components/ui/dialog/index.js';
  import MonitorIcon from '@lucide/svelte/icons/monitor';
  import { streamPicker } from '$lib/stream/streamPicker.svelte';
  import MenuRow from '$lib/components/menu/MenuRow.svelte';

  const open = $derived(streamPicker.entries !== null);
  const entries = $derived(streamPicker.entries ?? []);

  function openAll(): void {
    for (const e of entries) e.open();
    streamPicker.close();
  }
</script>

<Dialog.Root
  {open}
  onOpenChange={(o) => {
    if (!o) streamPicker.close();
  }}
>
  <Dialog.Content class="max-w-sm" data-testid="stream-picker">
    <Dialog.Header>
      <Dialog.Title>{streamPicker.title}</Dialog.Title>
    </Dialog.Header>
    <!-- min-w-0: Dialog.Content is a CSS grid; without this a long label pushes
         past the frame (same fix as WatchPartyPickerDialog). -->
    <div class="flex min-w-0 flex-col gap-1.5 py-1">
      {#each entries as e (e.slot)}
        <MenuRow
          data-testid="stream-picker-item"
          data-slot={e.slot}
          title={e.label}
          onclick={() => {
            e.open();
            streamPicker.close();
          }}
        >
          <MonitorIcon class="text-primary size-4 shrink-0" />
          <span class="min-w-0 flex-1 truncate">{e.label}</span>
        </MenuRow>
      {/each}
      <MenuRow
        class="mt-1 border border-border/60"
        data-testid="stream-picker-all"
        onclick={openAll}
      >
        <MonitorIcon class="text-primary size-4 shrink-0" />
        <span>Alle ansehen</span>
      </MenuRow>
    </div>
  </Dialog.Content>
</Dialog.Root>
