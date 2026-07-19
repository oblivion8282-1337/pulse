<!--
  Inline link-preview card rendered under a message when its content contains a
  supported provider URL (YouTube / Vimeo / Spotify). Fetches the oEmbed payload
  client-side (see `lib/embeds/oembed.svelte.ts`) and shows thumbnail + title +
  author. Mirrors InviteEmbed's card styling.

  Safety: the whole card links to the URL the user actually posted (same target
  as the autolink in the message text). Title / author / provider are rendered
  as escaped text; the thumbnail is https-validated before becoming an <img src>.
  A failed / unsupported lookup renders nothing — the raw link stays clickable
  in the message text.
-->
<script lang="ts">
  import type { EmbedProvider } from '$lib/embeds/providers';
  import { prefetchEmbed, embedData, keyResolved } from '$lib/embeds/oembed.svelte';

  let { url, provider }: { url: string; provider: EmbedProvider } = $props();

  // Re-runs if the URL changes (message edited to a different link).
  $effect(() => {
    prefetchEmbed(provider, url);
  });

  const data = $derived(embedData(url));
  const resolved = $derived(keyResolved(url));
  const thumb = $derived(
    data?.thumbnail_url && /^https:\/\//i.test(data.thumbnail_url) ? data.thumbnail_url : null
  );
  const providerName = $derived(data?.provider_name ?? provider.name);
</script>

{#if !resolved}
  <div
    class="mt-1 flex max-w-sm items-center gap-3 rounded-xl border border-border bg-bg-elev p-2 pr-3"
    data-testid="link-embed-loading"
  >
    <div class="aspect-video w-28 shrink-0 animate-pulse rounded-md bg-bg-hover"></div>
    <div class="flex-1 space-y-1.5">
      <div class="h-2.5 w-16 animate-pulse rounded bg-bg-hover"></div>
      <div class="h-3.5 w-36 animate-pulse rounded bg-bg-hover"></div>
      <div class="h-3 w-24 animate-pulse rounded bg-bg-hover"></div>
    </div>
  </div>
{:else if data}
  <a
    href={url}
    target="_blank"
    rel="noopener noreferrer"
    class="mt-1 flex max-w-sm items-center gap-3 rounded-xl border border-border bg-bg-elev p-2 pr-3 transition-colors hover:bg-bg-hover"
    data-testid="link-embed"
  >
    {#if thumb}
      <img
        src={thumb}
        alt=""
        loading="lazy"
        class="aspect-video w-28 shrink-0 rounded-md bg-bg-hover object-cover"
      />
    {/if}
    <div class="min-w-0 flex-1">
      <p class="text-text-muted truncate text-[11px] tracking-wide uppercase">{providerName}</p>
      {#if data.title}
        <p
          class="text-text-bright line-clamp-2 text-sm font-semibold"
          data-testid="link-embed-title"
        >
          {data.title}
        </p>
      {/if}
      {#if data.author_name}
        <p class="text-text-muted truncate text-xs" data-testid="link-embed-author">
          {data.author_name}
        </p>
      {/if}
    </div>
  </a>
{/if}
