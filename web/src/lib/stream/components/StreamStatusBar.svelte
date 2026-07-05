<!--
  StreamStatusBar — permanente "Was streame ich gerade?"-Übersicht für den
  Streamer. Erscheint direkt über der Voice-Leiste, sobald mindestens ein
  lokaler HQ-Stream läuft (Slot 0..MAX-1); verschwindet sonst komplett.

  Pro Slot ein Chip: [Icon] Label ✕
    - Label/Icon aus capture_source (label.ts) — z.B. "DELL U2720Q" / "Chrome" /
      "Stream N" (Linux-Portal-Fallback), überschreibbar via Inline-Edit.
    - Chip-Body-Klick öffnet den StreamPanel-Config-Dialog für genau den Slot.
    - ✕ stoppt nur diesen Slot.
    - Kein Live-/fps-Status im Chip — bewusst minimal.

  Rein Frontend — alle Daten liegen lokal (state.svelte.ts + label.ts); kein
  Backend, kein Video. Gleiche Muster wie ScreenShareModeButton (runningSlots,
  stopSlot, HqStreamDialog-per-Slot).
-->
<script lang="ts">
  import { tick } from 'svelte';
  import MonitorIcon from '@lucide/svelte/icons/monitor';
  import AppWindowIcon from '@lucide/svelte/icons/app-window';
  import PencilIcon from '@lucide/svelte/icons/pencil';
  import XIcon from '@lucide/svelte/icons/x';
  import { runningStreamSlots } from '../state.svelte';
  import { stopSlot } from '../slotControl.svelte';
  import { voice } from '$lib/voice/livekit.svelte';
  import {
    resolveSlotLabel,
    loadCustomLabels,
    saveCustomLabels,
    getCustomLabel,
    sanitizeCustomLabel,
  } from '../label';
  import HqStreamDialog from './HqStreamDialog.svelte';

  let runningSlots = $derived(runningStreamSlots());

  // Icon-Größe passend zur Voice-Leiste (Mute/Hangup): mobile size-6,
  // desktop size-4 — siehe `iconCls` in VoiceControlBar.svelte.
  const iconCls = 'size-6 md:size-4';
  // Per-Chip Icon-Buttons (Edit-Cancel / Edit-Label / Stop) — gleiche Geometrie,
  // nur andere Hover-Farbe pro Aktion.
  const chipIconBtn = 'rounded-full p-1.5 text-text-muted';

  // Chip-Body-Klick öffnet den StreamPanel-Config-Dialog für den Slot.
  let dialogOpen = $state(false);
  let dialogSlot = $state(0);

  // Per-slot custom-name Edit-Modus. `null` = keiner aktiv. Persistiert in
  // localStorage, damit der gewählte Name nach Reload / App-Restart erhalten
  // bleibt. Linux/Wayland-Portal liefert sonst nur "Stream N" (siehe label.ts).
  let customLabels = $state<Record<string, string>>(loadCustomLabels());
  let editingSlot = $state<number | null>(null);
  let editInput = $state('');
  let editInputEl = $state<HTMLInputElement | null>(null);

  function openConfig(slot: number): void {
    dialogSlot = slot;
    dialogOpen = true;
  }

  function startEditLabel(slot: number, currentLabel: string): void {
    const existing = getCustomLabel(customLabels, slot);
    editInput = existing ?? currentLabel;
    editingSlot = slot;
    // Erst nach dem Render fokussieren, sonst kennt der Binding das Element noch nicht.
    tick().then(() => {
      editInputEl?.focus();
      editInputEl?.select();
    });
  }
  function commitEditLabel(): void {
    if (editingSlot === null) return;
    const slot = editingSlot;
    const sanitized = sanitizeCustomLabel(editInput);
    const next = { ...customLabels };
    if (sanitized) next[String(slot)] = sanitized;
    else delete next[String(slot)];
    customLabels = next;
    saveCustomLabels(customLabels);
    editingSlot = null;
  }
  function cancelEditLabel(): void {
    editingSlot = null;
    editInput = '';
  }
  function onEditKey(e: KeyboardEvent): void {
    if (e.key === 'Enter') {
      e.preventDefault();
      commitEditLabel();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      cancelEditLabel();
    }
  }

  // Per-Slot Status-Anzeige bewusst weggelassen — der Chip zeigt nur Icon +
  // Label. Wer den tatsächlichen Slot-State braucht, kann ihn über das
  // StreamControls-Drawer (Detailpanel) oder den Health-Endpoint abfragen.
</script>

{#if runningSlots.length > 0}
  <div
    class="border-border mx-2 mt-2 flex flex-col gap-1 rounded-2xl border bg-bg-input/60 p-1.5"
    data-testid="stream-status-bar"
  >
    <div class="flex items-center gap-1.5 px-1 text-xs font-semibold text-text-muted">
      <span class="size-2 rounded-full bg-red-500" aria-hidden="true"></span>
      <span>{runningSlots.length} Stream{runningSlots.length === 1 ? '' : 's'}</span>
    </div>
    <div class="flex flex-col gap-1">
    {#each runningSlots as slot (slot)}
      {@const lbl = resolveSlotLabel(slot)}
      {@const customName = getCustomLabel(customLabels, slot)}
      {@const displayName = customName ?? lbl.label}
      {@const isEditing = editingSlot === slot}
      <div
        class="bg-bg/40 group flex w-full items-center gap-2 rounded-full py-0.5 pl-2 pr-0.5 text-xs"
        class:pr-1={isEditing}
        data-testid="stream-status-chip"
        data-slot={slot}
      >
        <div class="flex min-w-0 items-center gap-1.5">
          {#if lbl.icon === 'app'}
            <AppWindowIcon class="{iconCls} shrink-0" />
          {:else}
            <MonitorIcon class="{iconCls} shrink-0" />
          {/if}
          {#if isEditing}
            <input
              bind:this={editInputEl}
              bind:value={editInput}
              onkeydown={onEditKey}
              onblur={commitEditLabel}
              onclick={(e) => e.stopPropagation()}
              maxlength="40"
              data-testid="stream-status-label-input"
              aria-label="Stream-Label bearbeiten"
              class="text-text-bright placeholder:text-text-muted max-w-[10rem] rounded bg-bg/60 px-1.5 py-0.5 font-medium outline-none ring-1 ring-transparent focus:ring-text-bright"
              placeholder={lbl.label}
            />
            <button
              type="button"
              class="{chipIconBtn} hover:text-text-bright"
              onclick={(e) => {
                e.stopPropagation();
                cancelEditLabel();
              }}
              aria-label="Abbrechen"
              data-testid="stream-status-edit-cancel"
            >
              <XIcon class={iconCls} />
            </button>
          {:else}
            <button
              type="button"
              class="flex min-w-0 items-center gap-1.5"
              onclick={() => openConfig(slot)}
              aria-label="Stream-Einstellungen öffnen"
            >
              <span class="text-text-bright truncate font-medium" data-testid="stream-status-label">{displayName}</span>
            </button>
          {/if}
        </div>
        {#if !isEditing}
          <button
            type="button"
            class="{chipIconBtn} hover:bg-bg/60 hover:text-text-bright ml-auto"
            onclick={(e) => {
              e.stopPropagation();
              startEditLabel(slot, displayName);
            }}
            aria-label="Label umbenennen"
            data-testid="stream-status-edit-label"
            data-has-custom={customName ? 'true' : 'false'}
          >
            <PencilIcon class={iconCls} />
          </button>
        {/if}
        <button
          type="button"
          class="{chipIconBtn} hover:bg-red-500/20 hover:text-red-400"
          onclick={() => stopSlot(slot)}
          aria-label="Stream stoppen"
          data-testid="stream-status-stop"
        >
          <XIcon class={iconCls} />
        </button>
      </div>
    {/each}
    </div>
  </div>

  <HqStreamDialog bind:open={dialogOpen} channelId={voice.channelId} streamSlot={dialogSlot} />
{/if}
