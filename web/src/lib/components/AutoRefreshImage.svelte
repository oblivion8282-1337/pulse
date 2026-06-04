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

  Usage:
    <AutoRefreshImage attachmentId={a.id} src={a.thumb_url} alt={a.filename} thumb />
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

  let objectUrl = $state<string | null>(null);
  let failed = $state(false);

  function revoke() {
    if (objectUrl) {
      URL.revokeObjectURL(objectUrl);
      objectUrl = null;
    }
  }

  async function fetchInto(url: string): Promise<Response> {
    return fetch(url, { credentials: 'omit' });
  }

  // Load (and reload when the parent feeds a fresh src). The cleanup return
  // revokes the previous object-URL so we don't leak blobs as messages scroll.
  $effect(() => {
    const initial = src;
    let cancelled = false;
    failed = false;

    (async () => {
      let resp: Response;
      try {
        resp = await fetchInto(initial);
        if (resp.status === 403) {
          // Presigned URL expired → re-sign once and retry.
          const fresh = await chatApi.refreshAttachmentDownloadUrl(attachmentId);
          const next = (thumb ? fresh.thumb_url : fresh.url) ?? initial;
          resp = await fetchInto(next);
        }
        if (!resp.ok) throw new Error(`attachment ${resp.status}`);
        const blob = await resp.blob();
        if (cancelled) return;
        revoke();
        objectUrl = URL.createObjectURL(blob);
      } catch {
        if (!cancelled) failed = true;
      }
    })();

    return () => {
      cancelled = true;
      revoke();
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
  <!-- In flight — a dim placeholder keeps the layout from jumping. -->
  <span class="bg-bg-hover/40 block {klass}" aria-hidden="true"></span>
{/if}
