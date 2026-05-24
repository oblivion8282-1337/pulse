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

  guildId-Prop: Plugin-Widgets (z.B. Tamagotchi) sind seit der
  Admin-Activation per Guild gegated. Im DM/Friends-Kontext ist die
  Prop `''` und Plugin-UI rendert nicht — Plugin-Ops wären ohne
  Guild-Toggle eh vom Backend geblockt (4041/4043).
-->
<script lang="ts">
  import { voice } from '$lib/voice/livekit.svelte';
  import VoiceControlBar from './VoiceControlBar.svelte';
  import UserFooter from './UserFooter.svelte';
  import { viewport } from '$lib/stores/viewport.svelte';
  import { isPluginEnabledForGuild } from '$lib/plugins';
  import TamagotchiWidget from '../../../../plugins/tamagotchi/components/TamagotchiWidget.svelte';

  let { guildId = '' }: { guildId?: string } = $props();

  // Tamagotchi-Widget = erstes echtes Pulse-Plugin (Schritt 7). Bewusst
  // hardcoded gemountet — der UI-Slot-Plugin-Punkt kommt erst in einem
  // späteren Schritt. Conditional auf den Pro-Guild-Activation-State:
  // - Mobile: nie (Drawer zu eng).
  // - DM/Friends (`guildId === ''`): nie (Plugins gelten nicht für DMs).
  // - Guild ohne aktiviertes Tamagotchi: nie.
  const tamagotchiActive = $derived(
    !viewport.isMobile && !!guildId && isPluginEnabledForGuild(guildId, 'tamagotchi')
  );
</script>

{#if tamagotchiActive}
  <TamagotchiWidget {guildId} />
{/if}
{#if (voice.connected || voice.connecting) && !viewport.isMobile}
  <VoiceControlBar />
{/if}
<!-- Auf Mobil sitzt der eigene User unten in der GuildRail (s. dort) — hier
     nur auf Desktop, mit Name + Chip. -->
{#if !viewport.isMobile}
  <UserFooter />
{/if}
