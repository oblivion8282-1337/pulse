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

  let {
    session,
    /** Kann der Streamer ueberhaupt ferngesteuert werden? Kommt aus der
     *  WHEP-Antwort und stammt vom Sidecar des Streamers. Ohne das erschiene
     *  der Knopf auch bei einem Linux-Streamer: der Gastgeber bekaeme den
     *  Zustimmungs-Dialog fuer etwas, das nie funktionieren kann, und erst die
     *  ersten Frames liefen dann in einen Sidecar ohne `remote_input`-Modul. */
    fernsteuerbar = false
  }: { session: NativePlayerSession | null; fernsteuerbar?: boolean } = $props();
</script>

<!--
  `relative z-10` ist PFLICHT, nicht Kosmetik.

  TileShell legt einen transparenten Klick-Faenger (`absolute inset-0`) UEBER
  den Medieninhalt — fuer Doppelklick-Vollbild und den Tap auf Mobilgeraeten.
  Er steht nach `media()` im DOM und hat kein `pointer-events-none`, liegt in
  der Trefferpruefung also oben. Bis hierher war unter ihm immer nur ein
  `<video>`, also nie etwas Klickbares; dieses Panel ist der erste Fall mit
  Knoepfen.

  Ohne diese Zeile sind BEIDE Knoepfe tot: sie werden gezeichnet, zeigen aber
  keinen Hover, und der Klick landet im Faenger, der ausserhalb von
  „mobil + Vollbild" nichts tut. Kein Fehler, keine Meldung, nichts auf der
  Leitung — am 2026-08-12 hat genau das den Zwei-Geraete-Test blockiert und
  wie ein kaputtes Backend ausgesehen.
-->
<div
  class="relative z-10 flex h-full w-full flex-col items-center justify-center gap-3 bg-black p-4 text-white/70"
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
    {#if session && fernsteuerbar}
      <RemoteRequestButton
        channelId={session.channelId}
        hostUserId={session.userId}
        slot={session.slot}
      />
    {/if}
  </div>
</div>
