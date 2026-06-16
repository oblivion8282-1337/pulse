<script lang="ts">
  // Mute / deafen indicator for voice participants. Renders the plain
  // mic-off / headphone-off icon for a self-mute, and overlays a small
  // shield badge when the state was forced by a moderator — so a server-mute
  // is visually distinct from someone muting themselves.
  import MicOffIcon from '@lucide/svelte/icons/mic-off';
  import HeadphoneOffIcon from '@lucide/svelte/icons/headphone-off';
  import ShieldIcon from '@lucide/svelte/icons/shield';

  type Props = {
    kind: 'mic' | 'headphone';
    forced?: boolean;
    /** Tailwind size for the base icon (e.g. "size-3", "size-3.5"). */
    size?: string;
    label: string;
    testid?: string;
  };
  let { kind, forced = false, size = 'size-3', label, testid }: Props = $props();
</script>

{#if forced}
  <span class="relative inline-flex shrink-0" aria-label={label} role="img" data-testid={testid}>
    {#if kind === 'mic'}
      <MicOffIcon class="{size} text-red-400" />
    {:else}
      <HeadphoneOffIcon class="{size} text-red-400" />
    {/if}
    <ShieldIcon
      class="absolute -right-1 -bottom-1 size-2 fill-amber-400 stroke-bg-input stroke-[2.5]"
      aria-hidden="true"
    />
  </span>
{:else if kind === 'mic'}
  <MicOffIcon class="{size} text-red-400" aria-label={label} data-testid={testid} />
{:else}
  <HeadphoneOffIcon class="{size} text-red-400" aria-label={label} data-testid={testid} />
{/if}
