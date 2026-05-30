<!--
  Renders the attachments block under a message's content.

  Type-driven dispatch:
   - image/*   → AutoRefreshImage clickable → Lightbox
   - video/*   → native <video controls>
   - audio/*   → native <audio controls>
   - application/pdf → embed-card (link out, no inline pdf — most browsers'
                       built-in viewer is fine via the download anyway)
   - everything else → download-card with filename + size + icon

  Sizes are capped via CSS — a giant screenshot doesn't blow up the
  message column. The Lightbox is the route to actual-size viewing.
-->
<script lang="ts">
  import type { Attachment } from '$lib/api/types';
  import AutoRefreshImage from './AutoRefreshImage.svelte';
  import Lightbox from './Lightbox.svelte';
  import FileIcon from '@lucide/svelte/icons/file';
  import FileTextIcon from '@lucide/svelte/icons/file-text';
  import DownloadIcon from '@lucide/svelte/icons/download';
  import { m } from '$lib/paraglide/messages.js';

  let { attachments }: { attachments: Attachment[] } = $props();

  let lightboxAttachment = $state<Attachment | null>(null);
  let lightboxOpen = $state(false);

  function openLightbox(a: Attachment) {
    lightboxAttachment = a;
    lightboxOpen = true;
  }

  function fmtBytes(n: number): string {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
    return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
  }

  function kind(mime: string | null): 'image' | 'video' | 'audio' | 'pdf' | 'other' {
    if (!mime) return 'other';
    if (mime.startsWith('image/')) return 'image';
    if (mime.startsWith('video/')) return 'video';
    if (mime.startsWith('audio/')) return 'audio';
    if (mime === 'application/pdf') return 'pdf';
    return 'other';
  }
</script>

{#if attachments.length > 0}
  <div class="mt-1.5 flex flex-col gap-1.5" data-testid="message-attachments">
    {#each attachments as a (a.id)}
      {@const k = kind(a.mime)}
      {#if k === 'image'}
        <button
          type="button"
          class="block w-fit max-w-md cursor-zoom-in overflow-hidden rounded-xl border border-border focus:outline-none focus:ring-2 focus:ring-primary"
          onclick={() => openLightbox(a)}
          data-testid="attachment-image"
          aria-label={m.message_attachments_open_image({ filename: a.filename ?? m.message_attachments_unnamed() })}
        >
          <AutoRefreshImage
            attachmentId={a.id}
            src={a.thumb_url ?? a.url}
            alt={a.filename ?? ''}
            thumb={a.thumb_url !== null && a.thumb_url !== undefined}
            class="block max-h-96 w-auto object-cover"
          />
        </button>
      {:else if k === 'video'}
        <video
          src={a.url}
          controls
          preload="metadata"
          class="block max-h-96 w-fit max-w-md rounded-xl border border-border"
          data-testid="attachment-video"
        >
          <track kind="captions" />
        </video>
      {:else if k === 'audio'}
        <audio
          src={a.url}
          controls
          preload="metadata"
          class="block w-full max-w-md"
          data-testid="attachment-audio"
        ></audio>
      {:else}
        <a
          href={a.url}
          target="_blank"
          rel="noopener noreferrer"
          class="bg-bg-input hover:bg-bg-hover flex w-fit max-w-md items-center gap-3 rounded-xl border border-border px-3 py-2.5 text-sm transition-colors"
          data-testid="attachment-download"
          download={a.filename ?? undefined}
        >
          <div class="text-text-muted shrink-0">
            {#if k === 'pdf'}
              <FileTextIcon class="size-5" />
            {:else}
              <FileIcon class="size-5" />
            {/if}
          </div>
          <div class="min-w-0 flex-1">
            <p class="text-text-bright truncate font-medium">
              {a.filename ?? m.message_attachments_unnamed()}
            </p>
            <p class="text-text-muted text-xs">{fmtBytes(a.size)}</p>
          </div>
          <DownloadIcon class="text-text-muted size-4 shrink-0" />
        </a>
      {/if}
    {/each}
  </div>
{/if}

{#if lightboxAttachment}
  <Lightbox
    bind:open={lightboxOpen}
    attachmentId={lightboxAttachment.id}
    src={lightboxAttachment.url}
    alt={lightboxAttachment.filename ?? ''}
    filename={lightboxAttachment.filename}
  />
{/if}
