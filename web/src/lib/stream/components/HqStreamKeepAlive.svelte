<!--
  HqStreamKeepAlive — hält HQ-Stream-Verbindungen am Leben, solange der Viewer
  die Kachel offen hat, unabhängig davon, welcher Bildschirm gerade sichtbar ist.

  Wird EINMAL im persistenten App-Layout gemountet (überlebt jede Navigation).
  Gleicht den Manager-Bestand (`hqStreams`) gegen die offenen HQ-Kacheln ab:
  - Kachel offen (und nicht ins Popup ausgekoppelt)
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

  // Verlässt der Viewer die App (Logout → App-Layout unmountet), alle noch
  // laufenden HQ-Verbindungen sauber beenden. `nativePlayerSessions` schließt
  // hier nur mit — geöffnet wird ausschließlich vom WhepPlayer-Effect (gated
  // auf die useNativePlayer-Einstellung), s. dort.
  onDestroy(() => {
    hqStreams.reconcile([]);
    nativePlayerSessions.closeExcept([]);
  });

  $effect(() => {
    // Each HQ tile id is `<userId>:<slot>`; keep a WHEP connection per (user,
    // slot) tile that's open and not popped out.
    //
    // `openedTiles` ist die AUSDRÜCKLICHE Absicht des Zuschauers und füllt sich
    // nie von selbst: LIVE-Badge anklicken, Stream-Auswahl, Geräte-Weckruf
    // (`devices/schirme.svelte.ts`). Die Auto-Öffnen-Logik in
    // `VoiceChannelView` — der einzige Pfad, der ohne Klick öffnet — überspringt
    // den eigenen Nutzer ausdrücklich. Daran hängt die Verbindung; deshalb
    // braucht es hier keine Sonderregel für den eigenen Stream.
    const offen = openedTiles
      .entriesOfKind('hq')
      .map((e) => ({ channelId: e.channelId, ...parseHqTileId(e.id) }))
      .filter((e) => !detachedStreams.has(e.channelId, e.userId, e.slot));

    // **Der eigene Stream steht hier gleichberechtigt drin — KORREKTUR
    // 2026-08-19.**
    //
    // Hier stand ein Filter `e.userId !== myId` mit der Begruendung, die
    // Browser-Verbindung zum eigenen Stream sei „reine Verschwendung, das Bild
    // liegt lokal ohnehin vor". Beides trifft nicht zu:
    //
    // * Lokal liegt das Bild VOR dem Encoder vor. Der Selbstblick zeigt es
    //   danach — nach Encoder, Leitung und Server, also das, was beim Zuschauer
    //   wirklich ankommt. Genau dafuer ist er gebaut, und nur so laesst sich
    //   pruefen, was man sendet. Eine lokale Vorschau ersetzt das nicht.
    // * Der Filter hat den Selbstblick auch gar nicht verhindert, sondern nur
    //   ruiniert: `WhepPlayer.svelte` legt die Verbindung beim Mounten der
    //   Kachel an, dieser Abgleicher schloss sie beim naechsten Lauf, der
    //   naechste Effect-Lauf legte sie neu an. Ergebnis waren kurze
    //   Auf-/Zu-Sitzungen auf dem eigenen Pfad statt einer Verbindung, die
    //   steht — Bandbreite verbrannt UND kein brauchbares Bild.
    //
    // Ohne den Filter ist `openedTiles` fuer jeden Stream die eine Quelle:
    // keine Kachel offen → keine Verbindung, Kachel weggeklickt → `reconcile`
    // schliesst sie wirklich (nicht bloss das Bild).
    //
    // **ZWEI Listen bleiben es trotzdem, weil die Frage zweimal verschieden
    // beantwortet wird.** `closeExcept()` bekommt die volle Liste: dass das
    // Bild im eigenen Fenster laeuft, ist ja gerade der Grund, das Fenster
    // stehen zu lassen. Am 2026-08-07 hing dort schon einmal die engere Liste,
    // und der Aufraeumer schloss jedes eigene Player-Fenster sofort wieder. Das
    // war nicht nur ein totes Fenster: eine geschlossene Sitzung wird von
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
    hqStreams.reconcile(offen.filter((e) => !imFenster(e)));
    nativePlayerSessions.closeExcept(fensterWanted);
  });
</script>
