<!--
  Emoji-Knopf samt Auswahlfeld — eigene Datei, seit `MessageInput.svelte` bei
  der Anhang-Etappe geteilt wurde. Unveraendert uebernommen, dieselbe
  `data-testid`.

  Nur ab Tablet sichtbar: auf dem Handy liefert die Tastatur selbst Emojis,
  der Knopf nahm in der kompakten Zeile nur Platz weg.
-->
<script lang="ts">
  import * as DropdownMenu from '$lib/components/ui/dropdown-menu/index.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import SmilePlusIcon from '@lucide/svelte/icons/smile-plus';
  import EmojiPicker from '../EmojiPicker.svelte';
  import { m } from '$lib/paraglide/messages.js';

  let { onPick }: { onPick: (emoji: string) => void } = $props();
  let open = $state(false);

  function pick(emoji: string) {
    onPick(emoji);
    open = false;
  }
</script>

<DropdownMenu.Root bind:open>
  <DropdownMenu.Trigger>
    {#snippet child({ props })}
      <Button
        {...props}
        variant="ghost"
        size="icon"
        class="hidden size-10 md:inline-flex md:size-9"
        aria-label={m.message_input_insert_emoji()}
        data-testid="emoji-button"
      >
        <SmilePlusIcon class="size-5" />
      </Button>
    {/snippet}
  </DropdownMenu.Trigger>
  <DropdownMenu.Content
    side="top"
    align="end"
    sideOffset={6}
    class="w-auto max-w-[calc(100vw-1rem)] overflow-visible border-0 bg-transparent p-0 shadow-none"
  >
    <EmojiPicker onPick={pick} />
  </DropdownMenu.Content>
</DropdownMenu.Root>
