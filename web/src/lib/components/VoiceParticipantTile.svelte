<script lang="ts">
  import * as Avatar from '$lib/components/ui/avatar/index.js';
  import MicOffIcon from '@lucide/svelte/icons/mic-off';
  import VideoIcon from '@lucide/svelte/icons/video';
  import type { VoiceParticipant } from '$lib/voice/livekit.svelte';
  import { settings } from '$lib/stores/settings.svelte';
  import { userCache } from '$lib/stores/users.svelte';
  import { safeAvatarUrl } from '$lib/avatar';
  import UserProfilePopover from './UserProfilePopover.svelte';
  import VoiceUserVolumeControl from './VoiceUserVolumeControl.svelte';

  let { p }: { p: VoiceParticipant } = $props();

  $effect(() => {
    if (p.userId) userCache.queue(p.userId);
  });

  let glow = $derived(p.isSpeaking ? Math.min(1, 0.35 + p.audioLevel * 2) : 0);
  let initial = $derived((p.name.trim()[0] ?? '?').toUpperCase());
  let avatarSrc = $derived(p.userId ? safeAvatarUrl(userCache.get(p.userId)?.avatar_url) : null);

  let volumePct = $derived(
    p.userId ? Math.round(settings.getUserVolume(p.userId) * 100) : 100
  );
  let canAdjustVolume = $derived(!p.isLocal && p.userId !== null);
</script>

{#if p.userId}
<UserProfilePopover
  userId={p.userId}
  displayName={p.name}
  avatarUrl={avatarSrc}
>
  {#snippet children({ props })}
      <button
        {...props}
        type="button"
        class="glass-panel flex flex-col items-center gap-3 rounded-2xl px-6 py-5 text-left transition-colors data-[state=open]:ring-2 data-[state=open]:ring-primary/50"
        data-testid="voice-participant"
        data-identity={p.identity}
      >
        <div class="relative">
          {#if glow > 0}
            <div
              class="accent-gradient absolute -inset-1.5 rounded-full blur-[3px]"
              style={`opacity: ${0.35 + glow * 0.5};`}
            ></div>
          {/if}
          <Avatar.Root class="relative size-20">
            {#if avatarSrc}
              <Avatar.Image src={avatarSrc} alt={p.name} />
            {/if}
            <Avatar.Fallback class="accent-gradient text-primary-foreground text-xl font-semibold">
              {initial}
            </Avatar.Fallback>
          </Avatar.Root>
        </div>
        <div class="flex items-center gap-1 text-xs">
          <span class="text-text-bright max-w-28 truncate font-semibold" title={p.name}>
            {p.name}{p.isLocal ? ' (du)' : ''}
          </span>
          {#if p.micMuted}
            <MicOffIcon class="size-3 text-red-400" />
          {/if}
          {#if p.cameraOn}
            <VideoIcon class="size-3 text-primary" />
          {/if}
          {#if canAdjustVolume && volumePct !== 100}
            <span
              class="text-text-muted ml-1 font-mono text-[10px]"
              title="Eingestellte Lautstärke"
              data-testid="voice-participant-volume-badge"
            >
              {volumePct}%
            </span>
          {/if}
        </div>
      </button>
    {/snippet}
  {#snippet extra()}
    {#if canAdjustVolume && p.userId}
      <VoiceUserVolumeControl userId={p.userId} name={p.name} />
    {/if}
  {/snippet}
</UserProfilePopover>
{:else}
  <!-- Anonymous participants (no userId — pre-LiveKit-join race window):
       no popover, no DM, no volume — just the tile without interaction. -->
  <button
    type="button"
    class="glass-panel flex flex-col items-center gap-3 rounded-2xl px-6 py-5 text-left transition-colors"
    data-testid="voice-participant"
    data-identity={p.identity}
  >
    <div class="relative">
      {#if glow > 0}
        <div
          class="accent-gradient absolute -inset-1.5 rounded-full blur-[3px]"
          style={`opacity: ${0.35 + glow * 0.5};`}
        ></div>
      {/if}
      <Avatar.Root class="relative size-20">
        {#if avatarSrc}
          <Avatar.Image src={avatarSrc} alt={p.name} />
        {/if}
        <Avatar.Fallback class="accent-gradient text-primary-foreground text-xl font-semibold">
          {initial}
        </Avatar.Fallback>
      </Avatar.Root>
    </div>
    <div class="flex items-center gap-1 text-xs">
      <span class="text-text-bright max-w-28 truncate font-semibold" title={p.name}>
        {p.name}{p.isLocal ? ' (du)' : ''}
      </span>
      {#if p.micMuted}
        <MicOffIcon class="size-3 text-red-400" />
      {/if}
    </div>
  </button>
{/if}
