<!--
  RenameServerDialog — Anzeigename eines Self-Host-Servers ändern.

  Der Name ist ein lokales Feld im ServerEntry (`label`), kein Server-State:
  `serversStore.update` persistiert nach localStorage und stößt den
  E2E-Server-Vault-Push an (synct also auf die eigenen Geräte mit, sofern
  ein Vault eingerichtet ist). Der Hostname bleibt unverändert und ist in
  Tooltip/Server-Info weiterhin sichtbar.
-->
<script lang="ts">
  import * as Dialog from '$lib/components/ui/dialog/index.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import { Input } from '$lib/components/ui/input/index.js';
  import { Label } from '$lib/components/ui/label/index.js';
  import { serversStore, type ServerEntry } from '$lib/api/servers.svelte';
  import { m } from '$lib/paraglide/messages.js';

  let {
    open = false,
    server,
    onClose
  }: {
    open?: boolean;
    server: ServerEntry | null;
    onClose: () => void;
  } = $props();

  let name = $state('');

  $effect(() => {
    if (open && server) name = server.label.replace(/^https?:\/\//, '');
  });

  function handleOpenChange(next: boolean) {
    if (!next) {
      name = '';
      onClose();
    }
  }

  function submit(e: SubmitEvent) {
    e.preventDefault();
    if (!server) return;
    const trimmed = name.trim();
    if (trimmed && trimmed !== server.label) {
      serversStore.update(server.id, { label: trimmed });
    }
    onClose();
  }
</script>

<Dialog.Root {open} onOpenChange={handleOpenChange}>
  <Dialog.Content data-testid="rename-server-dialog">
    <Dialog.Header>
      <Dialog.Title>{m.rename_server_dialog_title()}</Dialog.Title>
      <Dialog.Description>
        {m.rename_server_dialog_description({
          host: server?.hostname.replace(/^https?:\/\//, '') ?? ''
        })}
      </Dialog.Description>
    </Dialog.Header>
    <form class="space-y-4" onsubmit={submit}>
      <div class="space-y-1.5">
        <Label
          for="rename-server-name"
          class="text-muted-foreground text-xs font-semibold uppercase tracking-wide"
        >
          {m.rename_server_dialog_name_label()}
        </Label>
        <Input
          id="rename-server-name"
          type="text"
          bind:value={name}
          required
          minlength={1}
          maxlength={32}
          data-testid="rename-server-name"
        />
      </div>
      <Dialog.Footer>
        <Button type="button" variant="ghost" onclick={() => handleOpenChange(false)}>
          {m.rename_server_dialog_cancel()}
        </Button>
        <Button type="submit" data-testid="rename-server-submit">
          {m.rename_server_dialog_save()}
        </Button>
      </Dialog.Footer>
    </form>
  </Dialog.Content>
</Dialog.Root>
