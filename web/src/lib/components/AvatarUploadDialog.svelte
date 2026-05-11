<script lang="ts">
  import * as Dialog from '$lib/components/ui/dialog/index.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import { toast } from 'svelte-sonner';
  import { uploadAvatar } from '$lib/api/auth';
  import { auth } from '$lib/stores/auth.svelte';

  let { open = $bindable(false) }: { open?: boolean } = $props();

  let file = $state<File | null>(null);
  let previewUrl = $state<string | null>(null);
  let busy = $state(false);

  function onFileChange(e: Event) {
    const input = e.currentTarget as HTMLInputElement;
    const f = input.files?.[0] ?? null;
    file = f;
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = f ? URL.createObjectURL(f) : null;
  }

  async function upload() {
    if (!file) return;
    busy = true;
    try {
      const updated = await uploadAvatar(file);
      if (auth.user) auth.setUser({ ...auth.user, avatar_url: updated.avatar_url });
      toast.success('Profilbild aktualisiert');
      open = false;
      file = null;
      if (previewUrl) { URL.revokeObjectURL(previewUrl); previewUrl = null; }
    } catch (e) {
      toast.error('Upload fehlgeschlagen', { description: (e as Error).message });
    } finally {
      busy = false;
    }
  }

  function onOpenChange(v: boolean) {
    if (!v) {
      file = null;
      if (previewUrl) { URL.revokeObjectURL(previewUrl); previewUrl = null; }
    }
    open = v;
  }
</script>

<Dialog.Root {open} onOpenChange={onOpenChange}>
  <Dialog.Portal>
    <Dialog.Overlay />
    <Dialog.Content data-testid="avatar-upload-dialog">
      <Dialog.Header>
        <Dialog.Title>Profilbild ändern</Dialog.Title>
        <Dialog.Description>PNG, JPEG oder WebP, max. 5 MB.</Dialog.Description>
      </Dialog.Header>

      <div class="flex flex-col items-center gap-4 py-4">
        {#if previewUrl}
          <img
            src={previewUrl}
            alt="Vorschau"
            class="size-24 rounded-full object-cover ring-2 ring-primary"
          />
        {/if}
        <label class="cursor-pointer">
          <span class="bg-bg-input text-text-base hover:bg-bg-hover rounded-md px-3 py-1.5 text-sm transition-colors">
            Datei auswählen
          </span>
          <input
            type="file"
            accept="image/png,image/jpeg,image/webp"
            class="sr-only"
            onchange={onFileChange}
            data-testid="avatar-file-input"
          />
        </label>
        {#if file}
          <p class="text-text-muted text-xs">{file.name}</p>
        {/if}
      </div>

      <Dialog.Footer>
        <Button variant="secondary" onclick={() => onOpenChange(false)} disabled={busy}>
          Abbrechen
        </Button>
        <Button onclick={upload} disabled={!file || busy} data-testid="avatar-upload-confirm">
          {busy ? 'Hochladen…' : 'Hochladen'}
        </Button>
      </Dialog.Footer>
    </Dialog.Content>
  </Dialog.Portal>
</Dialog.Root>
