<!--
  StreamStatusBar — permanente "Was streame ich gerade?"-Übersicht für den
  Streamer. Erscheint direkt unter der Voice-Leiste, sobald mindestens ein
  lokaler HQ-Stream läuft (Slot 0..MAX-1); verschwindet sonst komplett.

  Pro Slot ein Chip: [Icon] Label · Status · ✕
    - Label/Icon aus capture_source (label.ts) — z.B. "DELL U2720Q" / "Chrome" /
      "Stream N" (Linux-Portal-Fallback).
    - Status: live·fps / startet / Fehler.
    - Chip-Body-Klick öffnet den StreamPanel-Config-Dialog für genau den Slot.
    - ✕ stoppt nur diesen Slot.
  Rechts: "+ Stream" (nächstfreier Slot, disabled am Limit) + "Alle stoppen".

  Rein Frontend — alle Daten liegen lokal (state.svelte.ts + label.ts); kein
  Backend, kein Video. Gleiche Muster wie ScreenShareModeButton (runningSlots,
  nextFreeSlot, stopSlot/stopAll, HqStreamDialog-per-Slot).
-->
<script lang="ts">
  import MonitorIcon from '@lucide/svelte/icons/monitor';
  import AppWindowIcon from '@lucide/svelte/icons/app-window';
  import PlusIcon from '@lucide/svelte/icons/plus';
  import XIcon from '@lucide/svelte/icons/x';
  import { runningStreamSlots, streamForSlot } from '../state.svelte';
  import { nextFreeStreamSlot, stopSlot, stopAll } from '../slotControl.svelte';
  import { voice } from '$lib/voice/livekit.svelte';
  import { resolveSlotLabel } from '../label';
  import HqStreamDialog from './HqStreamDialog.svelte';

  let runningSlots = $derived(runningStreamSlots());
  // Niedrigster freier Slot — den startet das „+" als nächsten Stream.
  let nextFreeSlot = $derived(nextFreeStreamSlot());

  // Ein Dialog für beide Zwecke: Chip-Klick = laufender Slot (Config/Stop);
  // „+ Stream" = nächstfreier Slot (neuer Stream einrichten).
  let dialogOpen = $state(false);
  let dialogSlot = $state(0);

  function openConfig(slot: number): void {
    dialogSlot = slot;
    dialogOpen = true;
  }
  function openAdd(): void {
    if (nextFreeSlot < 0) return;
    dialogSlot = nextFreeSlot;
    dialogOpen = true;
  }

  // Status-Text + Farbe pro Slot — direkt aus der per-slot Session.
  function statusFor(slot: number): { text: string; cls: string } {
    const s = streamForSlot(slot);
    switch (s.state) {
      case 'live':
        return { text: s.fps != null ? `${s.fps} fps` : 'live', cls: 'text-emerald-400' };
      case 'starting':
        return { text: 'startet…', cls: 'text-amber-400' };
      case 'error':
        return { text: 'Fehler', cls: 'text-red-400' };
      default:
        return { text: '—', cls: 'text-text-muted' };
    }
  }
</script>

{#if runningSlots.length > 0}
  <div
    class="border-border mx-2 mb-2 flex flex-wrap items-center gap-1.5 rounded-2xl border bg-bg-input/60 p-1.5"
    data-testid="stream-status-bar"
  >
    <span class="text-text-muted flex shrink-0 items-center gap-1.5 px-1 text-xs font-semibold">
      <span class="size-2 rounded-full bg-red-500" aria-hidden="true"></span>
      {runningSlots.length} Stream{runningSlots.length === 1 ? '' : 's'}
    </span>

    {#each runningSlots as slot (slot)}
      {@const lbl = resolveSlotLabel(slot)}
      {@const st = statusFor(slot)}
      <div
        class="bg-bg/40 flex items-center gap-1 rounded-full py-0.5 pl-2 pr-0.5 text-xs"
        data-testid="stream-status-chip"
        data-slot={slot}
      >
        <button
          type="button"
          class="flex items-center gap-1.5"
          onclick={() => openConfig(slot)}
          aria-label="Stream-Einstellungen öffnen"
        >
          {#if lbl.icon === 'app'}
            <AppWindowIcon class="size-3.5 shrink-0" />
          {:else}
            <MonitorIcon class="size-3.5 shrink-0" />
          {/if}
          <span class="text-text-bright max-w-[10rem] truncate font-medium">{lbl.label}</span>
          <span class="text-text-muted {st.cls} shrink-0">· {st.text}</span>
        </button>
        <button
          type="button"
          class="text-text-muted hover:bg-red-500/20 hover:text-red-400 rounded-full p-1"
          onclick={() => stopSlot(slot)}
          aria-label="Stream stoppen"
          data-testid="stream-status-stop"
        >
          <XIcon class="size-3" />
        </button>
      </div>
    {/each}

    <div class="ml-auto flex shrink-0 items-center gap-1">
      <button
        type="button"
        class="text-text-muted hover:text-text-bright hover:bg-bg/40 flex items-center gap-1 rounded-full px-2 py-1 text-xs disabled:opacity-40"
        onclick={openAdd}
        disabled={nextFreeSlot < 0}
        data-testid="stream-status-add"
      >
        <PlusIcon class="size-3.5" /> Stream
      </button>
      <button
        type="button"
        class="text-red-400 hover:bg-red-500/20 hover:text-red-300 rounded-full px-2 py-1 text-xs"
        onclick={stopAll}
        data-testid="stream-status-stop-all"
      >
        Alle stoppen
      </button>
    </div>
  </div>

  <HqStreamDialog bind:open={dialogOpen} channelId={voice.channelId} streamSlot={dialogSlot} />
{/if}
