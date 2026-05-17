<!--
  Bottom of every sidebar: voice connection bar (if active) + user identity.

  Every left-sidebar variant (guild ChannelList, DMChannelList, the empty
  /app placeholder) renders this so the voice controls stay reachable
  wherever the user navigates. Without this, switching from a voice
  channel to a DM made the connection bar disappear and the only way to
  hang up was to navigate back to the voice channel.
-->
<script lang="ts">
  import { voice } from '$lib/voice/livekit.svelte';
  import VoiceControlBar from './VoiceControlBar.svelte';
  import UserFooter from './UserFooter.svelte';
</script>

{#if voice.connected || voice.connecting}
  <VoiceControlBar />
{/if}
<UserFooter />
