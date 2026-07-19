<!--
  TileDock — die Steuerleiste einer Video-Kachel (Name + Lautstärke + Aktionen).
  Wird von `TileShell` an zwei Stellen gerendert:
   * solide UNTER dem Video (Normal-Tile, `overlay=false`) — nichts liegt auf
     dem Bild,
   * als fadendes Overlay über dem unteren Bildrand im Vollbild
     (`overlay=true`) — immersiv wie ein Videoplayer.

  Responsives Kollabieren (`wide`): in breiten Kacheln liegen alle Controls
  inline; in schmalen Grid-Kacheln bleiben nur Essentielles (Lautstärke +
  Vollbild) sichtbar, der Rest (Stats/Chat/Detach/Schließen) wandert in
  ein ⋯-Menü. Lautstärke bleibt bewusst immer direkt erreichbar — sie ist die
  meistgenutzte Steuerung. `wide` ist im Vollbild immer true (Kachel ist groß).

  Alle data-testids sind 1:1 die der alten Overlay-Leiste — egal ob ein
  Control inline oder im ⋯-Menü liegt, die ID bleibt identisch.
-->
<script lang="ts">
  import type { Snippet, Component } from 'svelte';
  import Volume2Icon from '@lucide/svelte/icons/volume-2';
  import VolumeXIcon from '@lucide/svelte/icons/volume-x';
  import MaximizeIcon from '@lucide/svelte/icons/maximize';
  import MinimizeIcon from '@lucide/svelte/icons/minimize';
  import MessageSquareIcon from '@lucide/svelte/icons/message-square';
  import ExternalLinkIcon from '@lucide/svelte/icons/external-link';
  import ActivityIcon from '@lucide/svelte/icons/activity';
  import XIcon from '@lucide/svelte/icons/x';
  import EllipsisIcon from '@lucide/svelte/icons/ellipsis';
  import { m } from '$lib/paraglide/messages.js';
  import { VOLUME_BOOST_MAX } from '../volumeBoost';
  import { statsVisible } from '../statsVisible.svelte';
  import * as DropdownMenu from '$lib/components/ui/dropdown-menu/index.js';

  let {
    overlay = false,
    wide = true,
    kindIcon,
    kindIconColor = '',
    name,
    nameTestid,
    nameExtra,
    testidPrefix,
    volume,
    onVolumeChange,
    onToggleMute,
    audioBlocked = false,
    onEnableAudio,
    hasStats = false,
    chatOpen = false,
    onToggleChat,
    controlsExtra,
    onDetach,
    showDetach = false,
    isFullscreen = false,
    onToggleFullscreen,
    onHide
  }: {
    overlay?: boolean;
    wide?: boolean;
    kindIcon: Component;
    kindIconColor?: string;
    name: string;
    nameTestid?: string;
    nameExtra?: Snippet;
    testidPrefix: string;
    volume?: number;
    onVolumeChange?: (e: Event) => void;
    onToggleMute?: () => void;
    audioBlocked?: boolean;
    onEnableAudio?: () => void;
    hasStats?: boolean;
    chatOpen?: boolean;
    onToggleChat?: () => void;
    controlsExtra?: Snippet;
    onDetach?: () => void;
    showDetach?: boolean;
    isFullscreen?: boolean;
    onToggleFullscreen?: () => void;
    onHide?: () => void;
  } = $props();

  const KindIcon = $derived(kindIcon);

  // Button-Töne je nach Untergrund: über dem Video (overlay) helle Glyphen auf
  // Hover-Schleier; in der soliden Leiste neutrale Theme-Tokens.
  const tone = $derived(
    overlay
      ? 'text-white/90 hover:bg-white/15'
      : 'text-text-muted hover:bg-bg-hover hover:text-text'
  );
  const BTN_BASE = 'flex items-center justify-center rounded-md p-2 transition-colors md:p-1.5';
  const ICON = 'size-4';
  function btn(active = false): string {
    return `${BTN_BASE} ${tone} ${active ? '!text-primary' : ''}`;
  }

  // Welche Sekundär-Aktionen liegen vor → bestimmt, ob das ⋯-Menü im
  // Narrow-Modus überhaupt nötig ist.
  const hasOverflow = $derived(hasStats || !!onToggleChat || showDetach || !!onHide);
</script>

{#snippet fullscreenBtn()}
  <button
    type="button"
    onclick={() => onToggleFullscreen?.()}
    class={btn()}
    aria-label={isFullscreen
      ? m.tile_shell_fullscreen_exit()
      : m.tile_shell_fullscreen_enter()}
    title={isFullscreen ? m.tile_shell_fullscreen_exit() : m.tile_shell_fullscreen_enter()}
    data-testid={`${testidPrefix}-fullscreen`}
  >
    {#if isFullscreen}<MinimizeIcon class={ICON} />{:else}<MaximizeIcon class={ICON} />{/if}
  </button>
{/snippet}

<div class="flex items-center gap-2 px-2 py-1.5 {overlay ? 'text-white' : 'text-text'}">
  <!-- Name (im Narrow-Modus nur das Kind-Icon, um Platz für Volume zu schaffen) -->
  <div class="flex min-w-0 items-center gap-1.5 text-xs">
    <KindIcon class="size-3.5 shrink-0 {kindIconColor}" />
    {#if wide}
      <span class="truncate" data-testid={nameTestid}>{name}</span>
      {@render nameExtra?.()}
    {/if}
  </div>

  <div class="ml-auto flex items-center gap-1.5">
    {#if volume !== undefined}
      <div
        class="flex items-center gap-1.5 rounded-md px-2 py-1 {overlay ? 'bg-black/40' : 'bg-bg-hover'}"
      >
        <button
          type="button"
          onclick={() => onToggleMute?.()}
          class="flex items-center hover:opacity-70"
          aria-label={volume === 0 ? m.tile_shell_unmute() : m.tile_shell_mute()}
          data-testid={`${testidPrefix}-mute`}
        >
          {#if volume === 0}<VolumeXIcon class="size-3.5" />{:else}<Volume2Icon
              class="size-3.5"
            />{/if}
        </button>
        <input
          type="range"
          min="0"
          max={VOLUME_BOOST_MAX}
          value={volume}
          oninput={onVolumeChange}
          class="{wide ? 'w-24' : 'w-16'} {overlay ? 'accent-white' : 'accent-[#d4d4d8]'}"
          aria-label={m.tile_shell_volume()}
          data-testid={`${testidPrefix}-volume`}
        />
        <!-- Im Narrow-Modus ausgeblendet (Platz), aber im DOM gehalten, damit
             die testid stabil bleibt. -->
        <span
          class="w-9 text-right font-mono text-[11px] tabular-nums opacity-85 {wide ? '' : 'hidden'}"
          data-testid={`${testidPrefix}-volume-percent`}
        >{volume}%</span>
      </div>
    {/if}

    {#if audioBlocked}
      <button
        type="button"
        onclick={() => onEnableAudio?.()}
        class="flex items-center gap-1.5 rounded-md bg-destructive px-3 py-1.5 text-xs font-semibold text-white hover:bg-destructive/90 md:py-1"
        data-testid={`${testidPrefix}-unblock-audio`}
      >
        <VolumeXIcon class="size-3.5" />
        {#if wide}{m.tile_shell_enable_audio()}{/if}
      </button>
    {/if}

    {#if wide}
      <!-- Breite Kachel: alle Sekundär-Aktionen inline -->
      {#if hasStats}
        <button
          type="button"
          onclick={() => statsVisible.toggle()}
          class={btn(statsVisible.on)}
          aria-label={statsVisible.on ? m.tile_shell_stats_hide() : m.tile_shell_stats_show()}
          aria-pressed={statsVisible.on}
          title={m.tile_shell_stats_title()}
          data-testid={`${testidPrefix}-stats-toggle`}
        >
          <ActivityIcon class={ICON} />
        </button>
      {/if}
      {#if onToggleChat}
        <button
          type="button"
          onclick={() => onToggleChat?.()}
          class={btn(chatOpen)}
          aria-label={chatOpen ? m.tile_shell_chat_close() : m.tile_shell_chat_open()}
          aria-pressed={chatOpen}
          title={m.tile_shell_chat()}
          data-testid={`${testidPrefix}-chat-toggle`}
        >
          <MessageSquareIcon class={ICON} />
        </button>
      {/if}
      {#if showDetach}
        <button
          type="button"
          onclick={() => onDetach?.()}
          class={btn()}
          aria-label={m.tile_shell_detach()}
          title={m.tile_shell_detach()}
          data-testid={`${testidPrefix}-detach`}
        >
          <ExternalLinkIcon class={ICON} />
        </button>
      {/if}
      {@render fullscreenBtn()}
      {#if onHide}
        <button
          type="button"
          onclick={() => onHide?.()}
          class="{BTN_BASE} {overlay
            ? 'text-white/90 hover:bg-destructive'
            : 'text-text-muted hover:bg-destructive hover:text-white'}"
          aria-label={m.tile_shell_hide_tile()}
          title={m.tile_shell_hide()}
          data-testid={`${testidPrefix}-hide`}
        >
          <XIcon class={ICON} />
        </button>
      {/if}
    {:else}
      <!-- Schmale Kachel: Vollbild bleibt inline, Rest ins ⋯-Menü -->
      {@render fullscreenBtn()}
      {#if hasOverflow}
        <DropdownMenu.Root>
          <DropdownMenu.Trigger>
            {#snippet child({ props })}
              <button
                {...props}
                type="button"
                class={btn()}
                aria-label={m.tile_shell_more()}
                title={m.tile_shell_more()}
                data-testid={`${testidPrefix}-more`}
              >
                <EllipsisIcon class={ICON} />
              </button>
            {/snippet}
          </DropdownMenu.Trigger>
          <DropdownMenu.Content side="top" align="end" class="w-44">
            {#if hasStats}
              <DropdownMenu.Item
                onclick={() => statsVisible.toggle()}
                data-testid={`${testidPrefix}-stats-toggle`}
              >
                <ActivityIcon class={ICON} />
                {statsVisible.on ? m.tile_shell_stats_hide() : m.tile_shell_stats_show()}
              </DropdownMenu.Item>
            {/if}
            {#if onToggleChat}
              <DropdownMenu.Item
                onclick={() => onToggleChat?.()}
                data-testid={`${testidPrefix}-chat-toggle`}
              >
                <MessageSquareIcon class={ICON} />
                {chatOpen ? m.tile_shell_chat_close() : m.tile_shell_chat_open()}
              </DropdownMenu.Item>
            {/if}
            {#if showDetach}
              <DropdownMenu.Item
                onclick={() => onDetach?.()}
                data-testid={`${testidPrefix}-detach`}
              >
                <ExternalLinkIcon class={ICON} />
                {m.tile_shell_detach()}
              </DropdownMenu.Item>
            {/if}
            {#if onHide}
              <DropdownMenu.Separator />
              <DropdownMenu.Item
                onclick={() => onHide?.()}
                variant="destructive"
                data-testid={`${testidPrefix}-hide`}
              >
                <XIcon class={ICON} />
                {m.tile_shell_hide()}
              </DropdownMenu.Item>
            {/if}
          </DropdownMenu.Content>
        </DropdownMenu.Root>
      {/if}
    {/if}

    <!-- controlsExtra (Watch-Party-Host-Transport: Zurückspringen/Übergeben/
         Beenden) ganz rechts außen — so sitzt das Beenden-X am äußersten Rand,
         rechts vom Ausblenden-X. Nur die WatchPartyTile reicht das durch. -->
    {@render controlsExtra?.()}
  </div>
</div>
