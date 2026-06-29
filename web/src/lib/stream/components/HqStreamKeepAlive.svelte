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
  import { parseHqTileId } from '$lib/stream/hqTile';
  import { currentServerUserId } from '$lib/stores/currentServerUser';

  // Verlässt der Viewer die App (Logout → App-Layout unmountet), alle noch
  // laufenden HQ-Verbindungen sauber beenden.
  onDestroy(() => hqStreams.reconcile([]));

  $effect(() => {
    const myId = currentServerUserId();
    // Each HQ tile id is `<userId>:<slot>`; keep a WHEP connection per (user,
    // slot) tile that's open, not our own, and not popped out.
    const wanted = openedTiles
      .entriesOfKind('hq')
      .map((e) => ({ channelId: e.channelId, ...parseHqTileId(e.id) }))
      .filter((e) => e.userId !== myId && !detachedStreams.has(e.channelId, e.userId));
    hqStreams.reconcile(wanted);
  });
</script>
