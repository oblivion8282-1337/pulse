<!--
  `<img>` wrapper that re-signs its src when the browser sees a 403.

  Presigned MinIO URLs expire after 30 min (server config). For tabs that
  stay open longer than that, the browser fires `onerror` when it tries to
  reload the image. We catch that, call the refresh endpoint, swap the
  src in place. One retry — if the second URL also 403s, give up so we
  don't loop on a real auth problem.

  Usage:
    <AutoRefreshImage attachmentId={a.id} src={a.url} alt={a.filename} />
-->
<script lang="ts">
  import { chatApi } from '$lib/api/chat';

  let {
    attachmentId,
    src,
    alt,
    thumb = false,
    class: klass = ''
  }: {
    attachmentId: string;
    src: string;
    alt?: string;
    /** If true, refresh resolves to `thumb_url` instead of `url`. */
    thumb?: boolean;
    class?: string;
  } = $props();

  // Override that wins after a 403-refresh succeeds. While null, we show
  // the parent's `src`. When the parent re-renders with a fresh src, the
  // $effect clears the override so we go back to following the prop.
  let refreshedSrc = $state<string | null>(null);
  let triedRefresh = $state(false);

  $effect(() => {
    // Track src so this effect re-runs when the parent updates the prop.
    void src;
    refreshedSrc = null;
    triedRefresh = false;
  });

  const currentSrc = $derived(refreshedSrc ?? src);

  async function onError() {
    if (triedRefresh) return;
    triedRefresh = true;
    try {
      const fresh = await chatApi.refreshAttachmentDownloadUrl(attachmentId);
      const next = thumb ? fresh.thumb_url : fresh.url;
      if (next) refreshedSrc = next;
    } catch {
      /* leave the broken img — the user can refresh the page */
    }
  }
</script>

<img src={currentSrc} {alt} class={klass} loading="lazy" decoding="async" onerror={onError} />
