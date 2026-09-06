<!--
  Type-the-name confirmation for permanently deleting a community (owner tool).

  Bewusst eine EIGENE Komponente (nicht inline in AdminCommunities): ein
  bits-ui-Dialog mit Eingabefeld, das inline in einer Liste/Seite lebt, deren
  Eltern häufig re-rendern, verliert den Fokus im Feld (bekannter bits-ui-
  Fokus-Scope-Konflikt — siehe NicknameDialog/RenameGuildDialog, die alle aus
  demselben Grund eigenständig sind). Als eigene Komponente lebt der Feld-State
  hier, der Eltern-Render berührt den Dialog nicht mehr.

  ``open`` steuert der Aufrufer; ``onDeleted`` meldet Erfolg zurück (Zeile aus
  der Liste entfernen). Der Bestätigen-Knopf bleibt gesperrt, bis der getippte
  Name exakt passt (trim-only) — Schutz gegen versehentliches Löschen fremder
  Communities.
-->
<script lang="ts">
  import * as Dialog from '$lib/components/ui/dialog/index.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import { Input } from '$lib/components/ui/input/index.js';
  import { toast } from 'svelte-sonner';
  import { adminApi, type Community } from '$lib/api/admin';
  import { m } from '$lib/paraglide/messages.js';
  import { errText } from '$lib/utils/errText';

  let {
    open = false,
    community,
    onClose,
    onDeleted
  }: {
    open?: boolean;
    community: Community | null;
    onClose: () => void;
    onDeleted: (id: string) => void;
  } = $props();

  let confirmText = $state('');
  let busy = $state(false);
  let nameMatches = $derived(
    community !== null && confirmText.trim() === community.name
  );

  // Feld bei jedem Öffnen frisch (das Muster aus NicknameDialog).
  $effect(() => {
    if (open) confirmText = '';
  });

  function handleOpenChange(next: boolean) {
    if (!next) {
      confirmText = '';
      busy = false;
      onClose();
    }
  }

  async function submit(e: SubmitEvent) {
    e.preventDefault();
    if (!community || !nameMatches || busy) return;
    const target = community;
    busy = true;
    try {
      await adminApi.deleteCommunity(target.id);
      onDeleted(target.id);
      toast.success(m.admin_communities_deleted_toast());
      onClose();
    } catch (err) {
      toast.error(m.admin_communities_delete_failed(), {
        description: errText(err)
      });
    } finally {
      busy = false;
    }
  }
</script>

<Dialog.Root {open} onOpenChange={handleOpenChange}>
  <Dialog.Content data-testid="admin-community-delete-dialog">
    <Dialog.Header>
      <Dialog.Title>{m.admin_communities_delete_title()}</Dialog.Title>
      <Dialog.Description>
        {m.admin_communities_delete_body({ name: community?.name ?? '' })}
      </Dialog.Description>
    </Dialog.Header>
    <form class="space-y-4" onsubmit={submit}>
      <Input
        type="text"
        bind:value={confirmText}
        placeholder={m.admin_communities_delete_placeholder()}
        autocomplete="off"
        disabled={busy}
        data-testid="admin-community-delete-input"
      />
      <Dialog.Footer>
        <Button
          type="button"
          variant="ghost"
          onclick={() => handleOpenChange(false)}
          disabled={busy}
        >
          {m.admin_communities_delete_cancel()}
        </Button>
        <Button
          type="submit"
          variant="destructive"
          disabled={!nameMatches || busy}
          data-testid="admin-community-delete-confirm"
        >
          {m.admin_communities_delete_confirm()}
        </Button>
      </Dialog.Footer>
    </form>
  </Dialog.Content>
</Dialog.Root>
