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
  import { nativePlayerSessions } from '$lib/player/store.svelte';
  import { aufNachrichten, erfassungAn, erfassungAus } from '$lib/remote/playerInput';

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
    const slot = remoteSession.targetSlot;
    if (!steuernd || !sessionId || !channelId || !hostId) {
      hatteFenster = false;
      return;
    }
    // Reaktiv über die SvelteMap-Registry und `fensterSitzung` — das Fenster
    // geht asynchron auf, dieser Effect läuft dann erneut.
    const fenster = nativePlayerSessions.get(channelId, hostId, slot)?.fensterSitzung ?? null;
    if (fenster === null) {
      // Fenster zu, nachdem es offen war: ohne Fenster fließt keine Eingabe
      // mehr, und eine Sitzung, die nichts mehr überträgt, gehört beendet —
      // sonst stünde beim Host das Warnbanner für eine tote Verbindung.
      if (hatteFenster) remoteSession.end();
      return;
    }
    hatteFenster = true;
    // Scheitert das Einschalten, wird die Sitzung beendet statt weiterlaufen zu
    // lassen. Sonst steht beim Host das Warnbanner „wird ferngesteuert", der
    // Steuernde sieht einen „beenden"-Knopf — und es fließt kein einziges
    // Frame. Genau davor warnt `playerInput.ts::erfassungAn`, wenn es `false`
    // liefert. Erneut prüfen: zwischen Ruf und Antwort kann die Sitzung schon
    // eine andere sein, und dann gehörte dieses `end()` einer fremden.
    nacheinander(async () => {
      const ok = await erfassungAn(fenster, sessionId, slot);
      if (!ok && remoteSession.sessionId === sessionId) remoteSession.end();
    });
    return () => {
      // Der Player reicht danach noch die Hoch-Ereignisse für alles Gedrückte
      // nach; die gehen über dasselbe Abonnement unten hinaus.
      nacheinander(() => erfassungAus(fenster));
    };
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
