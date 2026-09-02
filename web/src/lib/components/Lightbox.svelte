<!--
  Click-to-open full-size image overlay. Built on bits-ui Dialog so we get
  focus-trap + ESC + click-outside-to-close for free. The image itself sits
  inside `AutoRefreshImage` so a long-open lightbox still loads after a
  presigned-URL expiry.

  Renderer-side this is only mounted when the user clicks an image
  attachment — keeps the DOM clean.
-->
<script lang="ts">
  import { Dialog as DialogPrimitive } from 'bits-ui';
  import AutoRefreshImage from './AutoRefreshImage.svelte';
  import XIcon from '@lucide/svelte/icons/x';
  import { m } from '$lib/paraglide/messages.js';
  import type { Attachment } from '$lib/api/types';

  let {
    open = $bindable(false),
    attachmentId,
    src,
    alt = '',
    filename,
    anhang = null
  }: {
    open?: boolean;
    attachmentId: string;
    src: string;
    alt?: string;
    filename?: string | null;
    /** Nur bei einem VERSCHLUESSELTEN Anhang gesetzt — wird unveraendert an
     *  `AutoRefreshImage` durchgereicht (s. dort). */
    anhang?: Attachment | null;
  } = $props();
</script>

<DialogPrimitive.Root bind:open>
  <DialogPrimitive.Portal>
    <DialogPrimitive.Overlay
      class="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm data-open:animate-in data-closed:animate-out data-open:fade-in-0 data-closed:fade-out-0"
    />
    <DialogPrimitive.Content
      class="fixed inset-4 z-50 flex items-center justify-center outline-none data-open:animate-in data-closed:animate-out data-open:fade-in-0 data-closed:fade-out-0 data-open:zoom-in-95 data-closed:zoom-out-95"
      data-testid="lightbox"
    >
      <DialogPrimitive.Title class="sr-only">
        {filename ?? m.lightbox_image_preview()}
      </DialogPrimitive.Title>

      <AutoRefreshImage
        {attachmentId}
        {src}
        {alt}
        {anhang}
        class="max-h-full max-w-full rounded-xl object-contain shadow-2xl"
      />

      <DialogPrimitive.Close>
        {#snippet child({ props })}
          <button
            {...props}
            class="absolute right-4 top-[max(1rem,var(--safe-top))] rounded-full bg-black/60 p-2 text-white hover:bg-black/80"
            aria-label={m.lightbox_close()}
            data-testid="lightbox-close"
          >
            <XIcon class="size-5" />
          </button>
        {/snippet}
      </DialogPrimitive.Close>
    </DialogPrimitive.Content>
  </DialogPrimitive.Portal>
</DialogPrimitive.Root>
