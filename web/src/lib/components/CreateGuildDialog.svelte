<script lang="ts">
  import * as Dialog from '$lib/components/ui/dialog/index.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import { Input } from '$lib/components/ui/input/index.js';
  import { Label } from '$lib/components/ui/label/index.js';

  let {
    open = false,
    onClose,
    onCreate
  }: {
    open?: boolean;
    onClose: () => void;
    onCreate: (name: string) => void;
  } = $props();

  let name = $state('');

  function handleOpenChange(next: boolean) {
    if (!next) {
      name = '';
      onClose();
    }
  }

  function submit(e: SubmitEvent) {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    onCreate(trimmed);
    name = '';
  }
</script>

<Dialog.Root {open} onOpenChange={handleOpenChange}>
  <Dialog.Content data-testid="create-guild-dialog">
    <Dialog.Header>
      <Dialog.Title>Server erstellen</Dialog.Title>
      <Dialog.Description>Gib deinem Server einen Namen.</Dialog.Description>
    </Dialog.Header>
    <form class="space-y-4" onsubmit={submit}>
      <div class="space-y-1.5">
        <Label for="create-guild-name" class="text-muted-foreground text-xs font-semibold uppercase tracking-wide">
          Server-Name
        </Label>
        <Input
          id="create-guild-name"
          type="text"
          bind:value={name}
          required
          minlength={1}
          maxlength={64}
          data-testid="create-guild-name"
        />
      </div>
      <Dialog.Footer>
        <Button type="button" variant="ghost" onclick={() => handleOpenChange(false)}>Abbrechen</Button>
        <Button type="submit" data-testid="create-guild-submit">Erstellen</Button>
      </Dialog.Footer>
    </form>
  </Dialog.Content>
</Dialog.Root>
