<script lang="ts">
  import * as Dialog from '$lib/components/ui/dialog/index.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import { Input } from '$lib/components/ui/input/index.js';
  import { Label } from '$lib/components/ui/label/index.js';
  import HashIcon from '@lucide/svelte/icons/hash';
  import Volume2Icon from '@lucide/svelte/icons/volume-2';

  let {
    open = false,
    onClose,
    onCreate
  }: {
    open?: boolean;
    onClose: () => void;
    onCreate: (name: string, type: number) => void;
  } = $props();

  let name = $state('');
  let type = $state(0); // 0 = text, 1 = voice

  function handleOpenChange(next: boolean) {
    if (!next) {
      name = '';
      type = 0;
      onClose();
    }
  }

  function submit(e: SubmitEvent) {
    e.preventDefault();
    const trimmed = name.trim().replace(/\s+/g, '-').toLowerCase();
    if (!trimmed) return;
    onCreate(trimmed, type);
    name = '';
    type = 0;
  }
</script>

<Dialog.Root {open} onOpenChange={handleOpenChange}>
  <Dialog.Content data-testid="create-channel-dialog">
    <Dialog.Header>
      <Dialog.Title>Kanal erstellen</Dialog.Title>
      <Dialog.Description>Erstelle einen neuen Text- oder Sprach-Kanal.</Dialog.Description>
    </Dialog.Header>
    <form class="space-y-4" onsubmit={submit}>
      <div class="space-y-1.5">
        <Label class="text-muted-foreground text-xs font-semibold uppercase tracking-wide">Kanal-Typ</Label>
        <div class="grid grid-cols-2 gap-2">
          <Button
            type="button"
            variant={type === 0 ? 'default' : 'secondary'}
            class="justify-start gap-2"
            onclick={() => (type = 0)}
            data-testid="create-channel-type-text"
          >
            <HashIcon class="size-4" />
            Text
          </Button>
          <Button
            type="button"
            variant={type === 1 ? 'default' : 'secondary'}
            class="justify-start gap-2"
            onclick={() => (type = 1)}
            data-testid="create-channel-type-voice"
          >
            <Volume2Icon class="size-4" />
            Sprache
          </Button>
        </div>
      </div>
      <div class="space-y-1.5">
        <Label for="create-channel-name" class="text-muted-foreground text-xs font-semibold uppercase tracking-wide">
          Kanal-Name
        </Label>
        <Input
          id="create-channel-name"
          type="text"
          bind:value={name}
          required
          minlength={1}
          maxlength={64}
          data-testid="create-channel-name"
        />
      </div>
      <Dialog.Footer>
        <Button type="button" variant="ghost" onclick={() => handleOpenChange(false)}>Abbrechen</Button>
        <Button type="submit" data-testid="create-channel-submit">Erstellen</Button>
      </Dialog.Footer>
    </form>
  </Dialog.Content>
</Dialog.Root>
