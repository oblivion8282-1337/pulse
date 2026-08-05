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
  import { nativePlayerSessions } from '$lib/player/store.svelte';
  import { parseHqTileId } from '$lib/stream/hqTile';
  import { currentServerUserId } from '$lib/stores/currentServerUser';

  // Verlässt der Viewer die App (Logout → App-Layout unmountet), alle noch
  // laufenden HQ-Verbindungen sauber beenden. `nativePlayerSessions` schließt
  // hier nur mit — geöffnet wird ausschließlich vom WhepPlayer-Effect (gated
  // auf die useNativePlayer-Einstellung), s. dort.
  onDestroy(() => {
    hqStreams.reconcile([]);
    nativePlayerSessions.closeExcept([]);
  });

  $effect(() => {
    const myId = currentServerUserId();
    // Each HQ tile id is `<userId>:<slot>`; keep a WHEP connection per (user,
    // slot) tile that's open, not our own, and not popped out.
    const wanted = openedTiles
      .entriesOfKind('hq')
      .map((e) => ({ channelId: e.channelId, ...parseHqTileId(e.id) }))
      .filter((e) => e.userId !== myId && !detachedStreams.has(e.channelId, e.userId, e.slot));
    // Laeuft das Bild im eigenen Fenster, braucht der Browser den Stream NICHT
    // mehr — das Fenster gibt Bild UND Ton aus (`#setAudioOwner`). Die
    // Browser-Verbindung blieb bisher trotzdem offen und dekodierte die
    // Videospur weiter, unsichtbar.
    //
    // Das war nicht nur Verschwendung (zwei volle WHEP-Kopien desselben
    // Streams an denselben Zuschauer), sondern hat am 2026-08-02 den Strom
    // fuer ALLE ruiniert: bei 10-bit-AV1 lehnt Chromiums dav1d-Anbindung
    // `bpc != 8` ab, der Decoder bekommt nie ein Bild zustande und fordert
    // dauerhaft Vollbilder an. Der Sender beantwortete jede Anforderung — 766
    // Vollbilder, eins alle 420 ms, sichtbar als Pumpen. Ein Decoder, der
    // nichts anzeigt, darf nicht mitreden.
    //
    // Erst bei `playing` abgeklemmt, nicht schon beim Verbinden: scheitert das
    // Fenster, faellt die Kachel auf den `<video>`-Weg zurueck, und dann soll
    // die Verbindung noch stehen.
    const imFenster = (e: { channelId: string; userId: string; slot: number }) =>
      nativePlayerSessions.get(e.channelId, e.userId, e.slot)?.phase === 'playing';
    hqStreams.reconcile(wanted.filter((e) => !imFenster(e)));
    nativePlayerSessions.closeExcept(wanted);
  });
</script>
