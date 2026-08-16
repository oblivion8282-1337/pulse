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

  **Die Fernsteuerungs-Anfrage sass bis 2026-08-16 hier**, mit der Begründung:
  erfasst wird IM Player-Fenster, wo keins läuft, gibt es nichts anzufragen. Das
  war technisch richtig und als Bedienung falsch herum — es zwang jeden, der
  steuern wollte, erst ein Fenster zu öffnen, dann ins Pulse-Fenster
  zurückzuwechseln und dort zu klicken. Der Knopf sitzt jetzt in der
  Bedienleiste der Kachel (`WhepPlayer`), und das Fenster geht auf, sobald der
  Host zusagt.
-->
<script lang="ts">
  import AppWindowIcon from '@lucide/svelte/icons/app-window';
  import { Button } from '$lib/components/ui/button/index.js';
  import type { NativePlayerSession } from '../store.svelte';
  import { m } from '$lib/paraglide/messages.js';

  let { session }: { session: NativePlayerSession | null } = $props();
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
  </div>
</div>
