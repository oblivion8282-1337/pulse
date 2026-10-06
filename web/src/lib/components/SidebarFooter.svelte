<!--
  Bottom of every sidebar: voice connection bar (if active) + user identity.

  Every left-sidebar variant (guild ChannelList, DMChannelList, the empty
  /app placeholder) renders this so the voice controls stay reachable
  wherever the user navigates. Without this, switching from a voice
  channel to a DM made the connection bar disappear and the only way to
  hang up was to navigate back to the voice channel.

  Mobil: die Sidebar lebt im Drawer — die Voice-Bar dort wäre nur über
  das Burger-Menü erreichbar. Darum auf Mobil HIER ausgeblendet; ChatView
  und VoiceChannelView rendern sie stattdessen als fixe Leiste über dem
  Composer (siehe dort).

  Hinweis: vor PR3 hing das Tamagotchi-Widget hier dran (Per-User-Pet).
  Mit PR3 ist das Pet pro Guild geteilt und wandert in die rechte
  Sidebar der Channel-Page (s. ``channels/[channelId]/+page.svelte``).
  SidebarFooter ist wieder auf Voice + User-Identity reduziert.
-->
<script lang="ts">
  import { voice } from '$lib/voice/livekit.svelte';
  import VoiceControlBar from './VoiceControlBar.svelte';
  import UserFooter from './UserFooter.svelte';
  import { viewport } from '$lib/stores/viewport.svelte';
</script>

{#if (voice.connected || voice.connecting) && !viewport.isMobile}
  <VoiceControlBar />
{/if}
<!-- Auf Mobil sitzt der eigene User unten in der GuildRail (s. dort) — hier
     nur auf Desktop, mit Name + Chip. -->
{#if !viewport.isMobile}
  <UserFooter />
{/if}
