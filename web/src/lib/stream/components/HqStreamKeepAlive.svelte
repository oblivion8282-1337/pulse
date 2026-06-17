<!--
  HqStreamKeepAlive — hält HQ-Stream-Verbindungen am Leben, solange der Viewer
  die Kachel offen hat, unabhängig davon, welcher Bildschirm gerade sichtbar ist.

  Wird EINMAL im persistenten App-Layout gemountet (überlebt jede Navigation).
  Gleicht den Manager-Bestand (`hqStreams`) gegen die offenen HQ-Kacheln ab:
  - Kachel offen (und nicht ins Popup ausgekoppelt, nicht der eigene Stream)
    → Verbindung läuft (Ton im Hintergrund, Bild sofort bei Rückkehr).
  - Kachel zu / Voice-Channel verlassen (openedTiles geleert) → sauber beendet.

  Rendert nichts — reine Lebenszyklus-Steuerung.
-->
<script lang="ts">
  import { onDestroy } from 'svelte';
  import { openedTiles } from '$lib/stream/openedTiles.svelte';
  import { detachedStreams } from '$lib/stream/detach.svelte';
  import { hqStreams } from '$lib/stream/hqStreamManager.svelte';
  import { currentServerUserId } from '$lib/stores/currentServerUser';

  // Verlässt der Viewer die App (Logout → App-Layout unmountet), alle noch
  // laufenden HQ-Verbindungen sauber beenden.
  onDestroy(() => hqStreams.reconcile([]));

  $effect(() => {
    const myId = currentServerUserId();
    const wanted = openedTiles
      .entriesOfKind('hq')
      .filter((e) => e.id !== myId && !detachedStreams.has(e.channelId, e.id))
      .map((e) => ({ channelId: e.channelId, userId: e.id }));
    hqStreams.reconcile(wanted);
  });
</script>
