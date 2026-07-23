<!--
  Attachment-thumbnail loader.

  Loads the image with `fetch()` and renders a same-origin object-URL instead
  of pointing `<img src>` straight at the object store. Why: a direct
  cross-origin `<img>` load against MinIO can stall indefinitely (the request
  sits in `pending`, firing neither `load` nor `error`) — most visible in dev
  where MinIO is a different origin than the app. `fetch()` of the very same
  URL succeeds and the resulting blob always decodes, so this path is reliable
  everywhere (and in production, where attachments are same-origin via the
  reverse proxy, `fetch` just hits the HTTP cache).

  Presigned URLs expire after ~30 min; a fetch that comes back 403 triggers a
  one-shot re-sign via the refresh endpoint, then a single re-fetch.

  The decoded blob is kept in a shared, ref-counted cache (`blobCache.ts`)
  keyed by attachment id + variant. The message list is virtualised, so the
  same image is unmounted and re-mounted repeatedly while scrolling; without
  the cache each remount re-fetched and the image blinked out in between.

  This component does NOT decide how big it is — the caller reserves the box
  (see `MessageAttachments`) and `klass` makes both states fill it, so the
  placeholder → image swap causes zero layout shift.

  Usage:
    <AutoRefreshImage attachmentId={a.id} src={a.thumb_url} alt={a.filename} thumb />
-->
<script lang="ts">
  import { chatApi } from '$lib/api/chat';
  import { acquire, release, store } from '$lib/attachments/blobCache';

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

  // Variant matters: full image and thumbnail are different bytes for the
  // same attachment id and must not share a cache slot.
  const cacheKey = $derived(`${attachmentId}:${thumb ? 't' : 'f'}`);

  let objectUrl = $state<string | null>(null);
  let failed = $state(false);

  async function fetchInto(url: string): Promise<Response> {
    return fetch(url, { credentials: 'omit' });
  }

  // Load (and reload when the parent feeds a fresh src). A cache hit resolves
  // synchronously, so a remount shows the image in the very first frame.
  $effect(() => {
    const key = cacheKey;
    const initial = src;
    let cancelled = false;
    let held = false;
    failed = false;

    async function load(): Promise<void> {
      try {
        let resp = await fetchInto(initial);
        if (resp.status === 403) {
          // Presigned URL expired → re-sign once and retry.
          const fresh = await chatApi.refreshAttachmentDownloadUrl(attachmentId);
          resp = await fetchInto((thumb ? fresh.thumb_url : fresh.url) ?? initial);
        }
        if (!resp.ok) throw new Error(`attachment ${resp.status}`);
        const url = URL.createObjectURL(await resp.blob());
        if (cancelled) {
          URL.revokeObjectURL(url);
          return;
        }
        objectUrl = store(key, url);
        held = true;
      } catch {
        if (!cancelled) failed = true;
      }
    }

    // Über die lokale Variable, nicht über `objectUrl` zurücklesen — ein Read
    // des eigenen $state im Effekt würde ihn von sich selbst abhängig machen.
    const cached = acquire(key);
    objectUrl = cached;
    held = cached !== null;
    if (!cached) void load();

    return () => {
      cancelled = true;
      objectUrl = null;
      if (held) release(key);
    };
  });
</script>

{#if objectUrl}
  <img src={objectUrl} {alt} class={klass} decoding="async" />
{:else if failed}
  <!-- Genuinely unreachable (404 after a re-sign, or network down). Render a
       neutral placeholder box instead of a broken-image glyph. -->
  <span class="bg-bg-hover text-text-muted flex items-center justify-center {klass}" aria-label={alt}>·</span>
{:else}
  <!-- In flight. Same `klass` as the <img>, so it occupies exactly the box the
       caller reserved and the swap moves nothing. -->
  <span class="bg-bg-hover/40 block {klass}" aria-hidden="true"></span>
{/if}
