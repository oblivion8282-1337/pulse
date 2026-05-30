<script lang="ts">
  import * as Dialog from '$lib/components/ui/dialog/index.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import { toast } from 'svelte-sonner';
  import { uploadAvatar } from '$lib/api/auth';
  import { auth } from '$lib/stores/auth.svelte';
  import { userCache } from '$lib/stores/users.svelte';
  import { m } from '$lib/paraglide/messages.js';

  let { open = $bindable(false) }: { open?: boolean } = $props();

  let file = $state<File | null>(null);
  let previewUrl = $state<string | null>(null);
  let busy = $state(false);

  // Client-seitige Vorab-Verkleinerung: spart Upload-Bandbreite. Der Server
  // verkleinert anschliessend nochmal auf 256px / WebP — aber wir wollen kein
  // 5-MB-Foto durchs Netz schicken nur damit der Server es klein macht.
  const MAX_DIM = 512;

  async function downscale(f: File): Promise<File> {
    if (f.size <= 256 * 1024) return f; // schon klein genug — Re-Encode lohnt nicht
    let bitmap: ImageBitmap;
    try {
      bitmap = await createImageBitmap(f, { imageOrientation: 'from-image' });
    } catch {
      return f; // Browser kann das Format nicht decoden — Server resized es eh
    }
    const scale = Math.min(1, MAX_DIM / Math.max(bitmap.width, bitmap.height));
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) { bitmap.close(); return f; }
    ctx.fillStyle = '#36393f'; // grauer statt schwarzer Hintergrund bei Transparenz
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(bitmap, 0, 0, w, h);
    bitmap.close();
    const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, 'image/jpeg', 0.9));
    if (!blob || blob.size >= f.size) return f; // hat nichts gebracht — Original behalten
    const name = f.name.replace(/\.[^.]+$/, '') + '.jpg';
    return new File([blob], name, { type: 'image/jpeg' });
  }

  async function onFileChange(e: Event) {
    const input = e.currentTarget as HTMLInputElement;
    const raw = input.files?.[0] ?? null;
    if (previewUrl) { URL.revokeObjectURL(previewUrl); previewUrl = null; }
    if (!raw) { file = null; return; }
    try {
      const processed = await downscale(raw);
      file = processed;
      previewUrl = URL.createObjectURL(processed);
    } catch (err) {
      file = null;
      toast.error(m.avatar_upload_dialog_image_process_error(), { description: (err as Error).message });
    }
  }

  async function upload() {
    if (!file) return;
    busy = true;
    try {
      const updated = await uploadAvatar(file);
      if (auth.user) {
        auth.setUser({ ...auth.user, avatar_url: updated.avatar_url });
        // auch den User-Cache aktualisieren, damit der Avatar in Nachrichten /
        // Mitgliederliste / Voice-Tiles sofort neu erscheint (nicht erst nach Reload)
        userCache.seed([
          {
            id: auth.user.id,
            username: auth.user.username,
            display_name: auth.user.display_name ?? null,
            avatar_url: updated.avatar_url
          }
        ]);
      }
      toast.success(m.avatar_upload_dialog_avatar_updated());
      open = false;
      file = null;
      if (previewUrl) { URL.revokeObjectURL(previewUrl); previewUrl = null; }
    } catch (e) {
      toast.error(m.avatar_upload_dialog_upload_failed(), { description: (e as Error).message });
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
        <Dialog.Title>{m.avatar_upload_dialog_title()}</Dialog.Title>
        <Dialog.Description>{m.avatar_upload_dialog_description()}</Dialog.Description>
      </Dialog.Header>

      <div class="flex flex-col items-center gap-4 py-4">
        {#if previewUrl}
          <img
            src={previewUrl}
            alt={m.avatar_upload_dialog_preview_alt()}
            class="size-24 rounded-full object-cover ring-2 ring-primary"
          />
        {/if}
        <label class="cursor-pointer">
          <span class="bg-bg-input text-text-base hover:bg-bg-hover rounded-md px-3 py-1.5 text-sm transition-colors">
            {m.avatar_upload_dialog_choose_file()}
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
          {m.avatar_upload_dialog_cancel()}
        </Button>
        <Button onclick={upload} disabled={!file || busy} data-testid="avatar-upload-confirm">
          {busy ? m.avatar_upload_dialog_uploading() : m.avatar_upload_dialog_upload()}
        </Button>
      </Dialog.Footer>
    </Dialog.Content>
  </Dialog.Portal>
</Dialog.Root>
