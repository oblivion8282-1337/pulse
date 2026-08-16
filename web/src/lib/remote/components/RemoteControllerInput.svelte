<!--
  RemoteControllerInput — Antrieb der STEUERNDEN Seite. Kein Markup, global
  gemountet (wie RemoteErrorToast).

  Zwei Aufgaben, beide an die laufende Sitzung gebunden:

  1. Erfassung im Player-Fenster ein- und ausschalten. Erfasst wird nur DORT —
     im Fenster, in dem der Steuernde das Bild des Hosts sieht. Ein Tastendruck
     in der App selbst geht die Fernsteuerung nichts an.
  2. Die gebündelten Frames auf der bestehenden WebSocket absetzen. Der
     Electron-Hauptprozess hat keine Verbindung zum Gateway (Begründung in
     `desktop/electron/remoteInput.ts`), er bündelt nur.

  Ohne offenes Player-Fenster gibt es keine Eingabe: das `<video>`-Element kann
  weder Zeiger fangen noch Scancodes liefern. Deshalb sitzt der Anfrage-Knopf
  auch genau dort (`$lib/player/components/NativeWindowPanel.svelte`).
-->
<script lang="ts">
  import { remoteSession } from '$lib/remote/session.svelte';
  import { remoteP2P } from '$lib/remote/p2p';
  import { nativePlayerSessions } from '$lib/player/store.svelte';
  import {
    aufNachrichten,
    erfassungAn,
    erfassungAus,
    transportMelden,
    zeigerformMelden,
    bildschirmeMelden,
  } from '$lib/remote/playerInput';
  import { deviceStore } from '$lib/devices/store.svelte';
  import { schirmWarten, schirmeVon } from '$lib/devices/schirme.svelte';
  import { remoteZeigerform } from '$lib/remote/zeigerform';
  import { onPlayerWindowRequest } from '$lib/player/client';

  const steuernd = $derived(
    remoteSession.phase === 'active' && remoteSession.role === 'controller'
  );

  // Absichtlich KEIN $state: dieser Merker wird im selben Effect gelesen und
  // geschrieben, der ihn setzt — als Rune wäre das eine Endlosschleife.
  let hatteFenster = false;

  // Ein- und Ausschalten der Erfassung laufen über EINE Kette, nie nebeneinander.
  // Beide Rufe sind asynchron (IPC in den Hauptprozess und weiter ins
  // Player-Fenster); ohne Kette konnte das Ausschalten des vorigen Durchlaufs
  // das Einschalten des neuen überholen, sobald sich `slot` oder `sessionId`
  // mitten in der Sitzung änderten — die Erfassung war danach still aus, obwohl
  // die Sitzung lief. Fehler werden verschluckt, damit ein einzelner Wurf die
  // Kette nicht für den Rest der Sitzung stilllegt.
  let kette: Promise<void> = Promise.resolve();
  function nacheinander(schritt: () => Promise<void>): void {
    kette = kette.then(schritt).catch(() => undefined);
  }

  $effect(() => {
    const sessionId = remoteSession.sessionId;
    const channelId = remoteSession.channelId;
    const hostId = remoteSession.peerUserId;
    if (!steuernd || !sessionId || !channelId || !hostId) {
      hatteFenster = false;
      return;
    }
    // **Jedes offene Fenster dieses Hosts, nicht nur eines.** Ein
    // Standplatz-Gerät kann mehrere Bildschirme gleichzeitig übertragen; die
    // Eingabe wird in jedem erfasst, und weil der Drahtvertrag die Platznummer
    // in JEDER Nachricht trägt, folgt sie von selbst dem Fenster, in dem die
    // Maus gerade ist. Eine zweite Sitzung braucht es dafür nicht — der Host
    // rechnet die Anteile in das Rechteck des jeweils gemeinten Schirms
    // (`remote_input/zuordnung.rs`).
    //
    // Reaktiv über die SvelteMap-Registry: geht ein weiteres Fenster auf,
    // läuft dieser Effect erneut und schaltet dessen Erfassung ein.
    const fenster = nativePlayerSessions
      .fuerHost(channelId, hostId)
      .map((s) => ({ nummer: s.fensterSitzung, slot: s.slot }))
      .filter((f): f is { nummer: number; slot: number } => f.nummer !== null);
    if (fenster.length === 0) {
      // Kein Fenster mehr, nachdem eines offen war: ohne Fenster fließt keine
      // Eingabe mehr, und eine Sitzung, die nichts mehr überträgt, gehört
      // beendet — sonst stünde beim Host das Warnbanner für eine tote
      // Verbindung.
      if (hatteFenster) remoteSession.end();
      return;
    }
    hatteFenster = true;
    // Scheitert das Einschalten ÜBERALL, wird die Sitzung beendet statt
    // weiterlaufen zu lassen. Ein einzelnes Fenster darf dagegen scheitern —
    // die übrigen tragen dann weiter, und der Steuernde merkt es daran, dass
    // ein Bildschirm nicht reagiert. Erneut prüfen: zwischen Ruf und Antwort
    // kann die Sitzung schon eine andere sein.
    nacheinander(async () => {
      const erfolge = await Promise.all(
        fenster.map((f) => erfassungAn(f.nummer, sessionId, f.slot)),
      );
      if (!erfolge.some(Boolean) && remoteSession.sessionId === sessionId) remoteSession.end();
    });
    // Anzeigetext des Eingabewegs und Form des Host-Zeigers in JEDES Fenster —
    // beides gehört zur Sitzung, nicht zu einem einzelnen Bildschirm. Der Sink
    // wird beim Setzen mit dem aktuellen Stand nachbeliefert, Übergänge vor dem
    // Anschluss gehen also nicht verloren.
    remoteP2P.setStatusSink((transport) => {
      for (const f of fenster) void transportMelden(f.nummer, transport);
    });
    remoteZeigerform.setSenke((form) => {
      for (const f of fenster) void zeigerformMelden(f.nummer, form);
    });
    return () => {
      remoteP2P.setStatusSink(null);
      remoteZeigerform.setSenke(null);
      // Der Player reicht danach noch die Hoch-Ereignisse für alles Gedrückte
      // nach; die gehen über dasselbe Abonnement unten hinaus.
      nacheinander(async () => {
        await Promise.all(fenster.map((f) => erfassungAus(f.nummer)));
      });
    };
  });

  // „Fernsteuerung beenden" aus dem Menü am Griff im Player-Fenster. Beendet
  // wird HIER, nicht dort: die Sitzung lebt in der App, und nur von hier aus
  // erfährt das Gegenüber davon. Der Player meldet deshalb bloß den Wunsch
  // (`OverlayAction::RemoteDisconnect`).
  //
  // Die Fenster-Nummer wird erst beim Ereignis nachgeschlagen, nicht beim
  // Abonnieren: sie ändert sich, wenn das Fenster zwischendurch neu aufgeht,
  // und ein beim Abonnieren eingefrorener Wert ließe den Knopf danach still
  // ins Leere laufen.
  $effect(() =>
    onPlayerWindowRequest((kind, session, monitor) => {
      // Bildschirm aus dem Menü am Griff: dieselbe Entscheidung wie in der
      // Geräteansicht (`schirme.svelte.ts`) — läuft er schon, kommt sein
      // Fenster nach vorne; sonst wird er geweckt.
      if (kind === 'remote-screen') {
        const channelId = remoteSession.channelId;
        const hostId = remoteSession.peerUserId;
        if (remoteSession.phase !== 'active' || !channelId || !hostId) return;
        const geraet = deviceStore.byChannelOwner(channelId, hostId);
        const mon = geraet ? schirmeVon(geraet).find((s) => s.index === monitor) : null;
        if (geraet && mon) schirmWarten.holen(geraet, mon);
        return;
      }
      if (kind !== 'remote-disconnect') return;
      const channelId = remoteSession.channelId;
      const hostId = remoteSession.peerUserId;
      if (remoteSession.phase !== 'active' || !channelId || !hostId) return;
      const fenster = nativePlayerSessions
        .fuerHost(channelId, hostId)
        .map((s) => s.fensterSitzung)
        .filter((n): n is number => n !== null);
      // Aus JEDEM Fenster dieser Sitzung, nicht nur aus dem zuerst
      // angefragten (Bughunt 2026-08-16): ein Standplatz-Gerät kann mehrere
      // Bildschirme zeigen, und in allen weiteren verpuffte der Klick auf
      // „Fernsteuerung beenden" wirkungslos. Fremde Fenster bleiben aussen vor
      // — die Prüfung ist jetzt „gehört zu diesem Host", nicht „ist genau
      // dieser eine Platz".
      if (!fenster.includes(session)) return;
      remoteSession.end();
    })
  );

  // **Die Bildschirmliste in einem EIGENEN Effect** (Bughunt 2026-08-16). Sie
  // hängt an den laufenden Strömen, und die ändern sich, sooft irgendwer im
  // Kanal etwas startet oder beendet. Stand sie im Effect oben, riss jede
  // solche fremde Meldung die Erfassung ab und baute sie neu auf — mit dem
  // Aufräumen ging dabei alles Gedrückte hoch. Mitten im Steuern.
  $effect(() => {
    const channelId = remoteSession.channelId;
    const hostId = remoteSession.peerUserId;
    if (!steuernd || !channelId || !hostId) return;
    const geraet = deviceStore.byChannelOwner(channelId, hostId);
    if (!geraet) return;
    const schirme = schirmeVon(geraet);
    for (const s of nativePlayerSessions.fuerHost(channelId, hostId)) {
      if (s.fensterSitzung !== null) void bildschirmeMelden(s.fensterSitzung, schirme);
    }
    // Ein angefordertes Bild einlösen, auch wenn die Geräteansicht gar nicht
    // offen ist — der Wunsch kann aus dem Player-Fenster gekommen sein.
    schirmWarten.einloesen(geraet);
  });

  // Ein Abonnement für die ganze Laufzeit. Es endet NICHT mit der Sitzung: die
  // Hoch-Ereignisse des Abschaltens kommen erst danach, und genau die dürfen
  // nicht verloren gehen.
  $effect(() =>
    aufNachrichten((n) => {
      // Abgesetzt wird über den Store, nicht über `gateway`: nur der Store
      // kennt die Verbindung, auf der die Sitzung wirklich läuft. Über den
      // Proxy gingen die Frames samt `session_id` nach einem Serverwechsel an
      // einen fremden Server, der die Sitzung nicht kennt. Die Prüfung „gehört
      // zur eigenen, laufenden Sitzung" macht `sendInput` selbst.
      remoteSession.sendInput(n.session_id, n.slot, n.frames);
    })
  );
</script>
