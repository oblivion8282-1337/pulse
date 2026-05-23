<!--
  Reusable status indicator dot.

  ``status`` mirrors the PresenceStatus union; ``invisible`` is accepted
  as an alias for ``offline`` (shown as grey, consistent with how invisible
  peers appear to others). Sizes via Tailwind utility class prop.
-->
<script lang="ts">
  let {
    status,
    class: extraClass = ''
  }: {
    status: 'online' | 'idle' | 'dnd' | 'offline' | 'invisible';
    class?: string;
  } = $props();

  function dotClass(s: string): string {
    switch (s) {
      case 'online':
        return 'bg-emerald-500';
      case 'idle':
        return 'bg-amber-400';
      case 'dnd':
        return 'bg-rose-500';
      default:
        return 'bg-zinc-500';
    }
  }
</script>

<span
  class="inline-block shrink-0 rounded-full {dotClass(status)} {extraClass}"
  aria-label={status}
></span>
