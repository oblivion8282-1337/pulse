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
-->
<script lang="ts">
  import { voice } from '$lib/voice/livekit.svelte';
  import VoiceControlBar from './VoiceControlBar.svelte';
  import UserFooter from './UserFooter.svelte';
  import { viewport } from '$lib/stores/viewport.svelte';
  import { pluginActivation } from '$lib/plugins';
  import TamagotchiWidget from '../../../../plugins/tamagotchi/components/TamagotchiWidget.svelte';

  // Tamagotchi-Widget = erstes echtes Pulse-Plugin (Schritt 7). Bewusst
  // hardcoded gemountet — der UI-Slot-Plugin-Punkt kommt erst in einem
  // späteren Schritt. Conditional auf den persistierten Activation-State
  // → wenn der User das Plugin im Plugin-Manager-UI ausschaltet,
  // verschwindet die Karte beim nächsten Reactive-Tick. Nur Desktop, weil
  // der Mobile-Drawer eh viel zu eng für so eine zusätzliche Karte ist.
  const tamagotchiActive = $derived(
    !viewport.isMobile && pluginActivation.activated.includes('tamagotchi')
  );
</script>

{#if tamagotchiActive}
  <TamagotchiWidget />
{/if}
{#if (voice.connected || voice.connecting) && !viewport.isMobile}
  <VoiceControlBar />
{/if}
<!-- Auf Mobil sitzt der eigene User unten in der GuildRail (s. dort) — hier
     nur auf Desktop, mit Name + Chip. -->
{#if !viewport.isMobile}
  <UserFooter />
{/if}
