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
  import { gateway } from '$lib/ws/connection';

  const steuernd = $derived(
    remoteSession.phase === 'active' && remoteSession.role === 'controller'
  );

  // Absichtlich KEIN $state: dieser Merker wird im selben Effect gelesen und
  // geschrieben, der ihn setzt — als Rune wäre das eine Endlosschleife.
  let hatteFenster = false;

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
    void erfassungAn(fenster, sessionId, slot);
    return () => {
      // Der Player reicht danach noch die Hoch-Ereignisse für alles Gedrückte
      // nach; die gehen über dasselbe Abonnement unten hinaus.
      void erfassungAus(fenster);
    };
  });

  // Ein Abonnement für die ganze Laufzeit. Es endet NICHT mit der Sitzung: die
  // Hoch-Ereignisse des Abschaltens kommen erst danach, und genau die dürfen
  // nicht verloren gehen.
  $effect(() =>
    aufNachrichten((n) => {
      // Nur was zur eigenen, laufenden Sitzung gehört. Ein Nachzügler einer
      // beendeten Sitzung würde vom Gateway ohnehin mit 4053 abgewiesen.
      if (remoteSession.role !== 'controller') return;
      if (!n.session_id || n.session_id !== remoteSession.sessionId) return;
      gateway.sendRemoteInput(n.session_id, n.slot, n.frames);
    })
  );
</script>
