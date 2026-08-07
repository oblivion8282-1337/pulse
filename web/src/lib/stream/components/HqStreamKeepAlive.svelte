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
    const offen = openedTiles
      .entriesOfKind('hq')
      .map((e) => ({ channelId: e.channelId, ...parseHqTileId(e.id) }))
      .filter((e) => !detachedStreams.has(e.channelId, e.userId, e.slot));

    // **ZWEI Listen, weil die Frage zweimal verschieden beantwortet wird.**
    //
    // Bis zum 2026-08-07 gab es nur eine, gefiltert fuer die Browser-Verbindung
    // — und `closeExcept()` unten bekam sie ebenfalls. Der eigene Stream faellt
    // aus dieser Liste heraus (`userId !== myId`, s.u.), also schloss der
    // Aufraeumer JEDES eigene Player-Fenster sofort wieder.
    //
    // Das war nicht nur ein totes Fenster: eine geschlossene Sitzung wird von
    // `nativePlayerSessions.ensure()` bewusst durch eine neue ersetzt (damit
    // eine Kachel nach einem Fehler nicht dauerhaft im Rueckfall haengt). Beide
    // zusammen ergaben eine Endlosschleife aus Oeffnen und Schliessen, jede
    // Runde mit einer neuen WHEP-Adresse vom Server und einem vollen
    // WebRTC-Aufbau. Danach half nur noch, Pulse ganz zu beenden.
    //
    // Der eigene Stream im eigenen Fenster ist ausdruecklich gewollt: Chromium
    // zeigt kein HDR und keine 10 bit, der Player schon — nur so laesst sich am
    // eigenen Rechner beurteilen, was beim Zuschauer ankommt.
    const fensterWanted = offen;

    // Die Browser-Verbindung dagegen braucht der eigene Stream NICHT: das Bild
    // liegt lokal ohnehin vor, und eine zweite WHEP-Kopie zu sich selbst waere
    // reine Verschwendung.
    const wanted = offen.filter((e) => e.userId !== myId);
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
    nativePlayerSessions.closeExcept(fensterWanted);
  });
</script>
