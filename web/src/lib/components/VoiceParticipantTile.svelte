<script lang="ts">
  import * as Avatar from '$lib/components/ui/avatar/index.js';
  import MicOffIcon from '@lucide/svelte/icons/mic-off';
  import type { VoiceParticipant } from '$lib/voice/livekit.svelte';

  let { p }: { p: VoiceParticipant } = $props();

  // Glow intensity from audioLevel while speaking; clamps to a visible range.
  let glow = $derived(p.isSpeaking ? Math.min(1, 0.35 + p.audioLevel * 2) : 0);
  let initial = $derived((p.name.trim()[0] ?? '?').toUpperCase());
</script>

<div
  class="glass-panel flex flex-col items-center gap-3 rounded-2xl px-6 py-5 transition-colors"
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
</div>
