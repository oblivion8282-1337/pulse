<!--
  WatchPartyPickerDialog — global chooser shown when a user hosts more than one
  watch party and someone clicks their PARTY badge. Mounted once in the app
  layout; driven by the `watchPartyPicker` store. Single-party clicks never open
  this (they open directly) — see lib/watch/openParty.svelte.ts.
-->
<script lang="ts">
  import * as Dialog from '$lib/components/ui/dialog/index.js';
  import PlayCircleIcon from '@lucide/svelte/icons/play-circle';
  import { watchPartyPicker } from '$lib/watch/openParty.svelte';

  const open = $derived(watchPartyPicker.entries !== null);
</script>

<Dialog.Root
  {open}
  onOpenChange={(o) => {
    if (!o) watchPartyPicker.close();
  }}
>
  <Dialog.Content class="max-w-sm" data-testid="watch-party-picker">
    <Dialog.Header>
      <Dialog.Title>{watchPartyPicker.title}</Dialog.Title>
    </Dialog.Header>
    <div class="flex flex-col gap-1.5 py-1">
      {#each watchPartyPicker.entries ?? [] as e (e.id)}
        <button
          type="button"
          class="hover:bg-bg-hover flex items-center gap-2 rounded-md px-3 py-2 text-left text-sm transition-colors"
          data-testid="watch-party-picker-item"
          onclick={() => {
            e.open();
            watchPartyPicker.close();
          }}
        >
          <PlayCircleIcon class="text-primary size-4 shrink-0" />
          <span class="truncate">{e.label}</span>
        </button>
      {/each}
    </div>
  </Dialog.Content>
</Dialog.Root>
