<!--
  NativeWindowPanel — was in der Kachel steht, während das Bild im eigenen
  Fenster läuft (nativer HQ-Player).

  Bewusst klein: Bedienung und Messwerte sitzen seit 2026-07-26 IM Fenster
  (`streaming/pulse-player/src/overlay.rs`), eine zweite Anzeige derselben
  Zahlen wäre nur eine weitere Stelle, die auseinanderlaufen kann. Hier bleibt
  der Weg zurück zum Fenster — nötig, weil das Fenster ohne Aktivierung öffnet
  und hinter der App liegen kann.

  Die Lautstärke der umgebenden `TileShell` bleibt bestehen und wirkt auf
  dasselbe Ziel: sie ist die Fernbedienung für den Fall, dass das Fenster gar
  nicht sichtbar ist.

  Die Fernsteuerungs-Anfrage sitzt hier und nirgends sonst: erfasst wird IM
  Player-Fenster (Zeigerfang, rohe Scancodes), das `<video>`-Element der Kachel
  kann das nicht. Wo kein Fenster läuft, gibt es also auch nichts anzufragen.
-->
<script lang="ts">
  import AppWindowIcon from '@lucide/svelte/icons/app-window';
  import { Button } from '$lib/components/ui/button/index.js';
  import type { NativePlayerSession } from '../store.svelte';
  import RemoteRequestButton from '$lib/remote/components/RemoteRequestButton.svelte';
  import { m } from '$lib/paraglide/messages.js';

  let { session }: { session: NativePlayerSession | null } = $props();
</script>

<div
  class="flex h-full w-full flex-col items-center justify-center gap-3 bg-black p-4 text-white/70"
  data-testid="hq-stream-native-panel"
>
  <AppWindowIcon class="size-7 shrink-0" />
  <p class="max-w-xs text-center text-xs">{m.whep_player_native_window()}</p>
  <div class="flex flex-wrap items-center justify-center gap-2">
    <Button
      variant="secondary"
      size="sm"
      onclick={() => session?.focus()}
      disabled={!session}
      data-testid="hq-stream-native-focus"
    >
      {m.native_panel_focus_window()}
    </Button>
    {#if session}
      <RemoteRequestButton
        channelId={session.channelId}
        hostUserId={session.userId}
        slot={session.slot}
      />
    {/if}
  </div>
</div>
