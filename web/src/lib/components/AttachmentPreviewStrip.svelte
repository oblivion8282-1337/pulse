<!--
  Composer-side strip of pending attachments. One tile per file:
    - preview thumbnail (or generic file icon)
    - progress bar at the bottom while uploading
    - red overlay on error (hover for message)
    - X-button to remove (calls back into the parent to also abort the XHR)

  Lives separately from MessageInput so the composer stays under the
  Svelte-component size cap.
-->
<script lang="ts">
  import type { PendingAttachment } from '$lib/attachments/upload.svelte';
  import FileIcon from '@lucide/svelte/icons/file';
  import XIcon from '@lucide/svelte/icons/x';
  import { m } from '$lib/paraglide/messages.js';

  let {
    pending,
    onRemove
  }: {
    pending: PendingAttachment[];
    onRemove: (localId: string) => void;
  } = $props();

  // Die Fehlermeldungen im Klartext unter der Leiste — bis 2026-09-01 standen
  // sie ausschliesslich im `title` der roten Kachel, waren also nur beim
  // Darueberfahren zu lesen und auf einem Touchgeraet gar nicht.
  //
  // Das reichte, solange ein Fehlschlag „Upload ging schief, nochmal
  // versuchen" hiess. Seit ein Anhang in die Cloud-Ordner aller Beteiligten
  // wandert (Design §11.1), sagt die Meldung, WAS zu tun ist — „einer der
  // Beteiligten hat kein Laufwerk verbunden" ist kein Rauschen, sondern die
  // ganze Auskunft. Eine Meldung, die niemand liest, ist ein stiller
  // Fehlschlag mit zusaetzlichen Schritten.
  //
  // Dedupliziert: drei Dateien mit derselben Ursache ergeben eine Zeile.
  let fehlerTexte = $derived([
    ...new Set(
      pending.flatMap((p) => (p.state === 'error' && p.errorMessage ? [p.errorMessage] : []))
    )
  ]);
</script>

{#if pending.length > 0}
  <div
    class="bg-bg-input/80 mb-1 flex flex-wrap gap-2 rounded-t-xl border border-b-0 border-border px-3 py-2"
    data-testid="attachment-preview-strip"
  >
    {#each pending as p (p.localId)}
      <div class="relative">
        <div
          class="bg-bg-hover flex h-16 w-16 items-center justify-center overflow-hidden rounded-md border border-border"
          data-testid="attachment-preview"
        >
          {#if p.previewUrl}
            <img src={p.previewUrl} alt={p.file.name} class="size-full object-cover" />
          {:else}
            <FileIcon class="text-text-muted size-6" />
          {/if}
        </div>
        {#if p.state === 'uploading' || p.state === 'queued'}
          <div class="absolute inset-x-0 bottom-0 h-1 overflow-hidden rounded-b-lg bg-black/40">
            <div
              class="h-full bg-primary transition-[width] duration-150"
              style="width: {p.progress}%"
            ></div>
          </div>
        {/if}
        {#if p.state === 'error'}
          <div
            class="absolute inset-0 flex items-center justify-center rounded-md bg-destructive/80 text-2xs font-semibold text-white"
            title={p.errorMessage ?? ''}
            data-testid="attachment-error"
          >
            {m.attachment_preview_strip_error()}
          </div>
        {/if}
        <button
          type="button"
          class="bg-bg-panel text-text-muted hover:text-text-bright absolute -right-1.5 -top-1.5 rounded-full border border-border p-0.5"
          onclick={() => onRemove(p.localId)}
          aria-label={m.attachment_preview_strip_remove_label()}
          data-testid="attachment-remove"
        >
          <XIcon class="size-3" />
        </button>
      </div>
    {/each}
    {#if fehlerTexte.length > 0}
      <ul
        class="text-destructive w-full list-none text-xs"
        data-testid="attachment-error-text"
        aria-live="polite"
      >
        {#each fehlerTexte as text (text)}
          <li>{text}</li>
        {/each}
      </ul>
    {/if}
  </div>
{/if}
