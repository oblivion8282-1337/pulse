<!--
  DeviceKiosk — was ein eingetragenes Gerät dauerhaft tun muss, damit es
  erreichbar bleibt. Rendert nichts.

  **Der Bildschirm darf nicht ausgehen.** Die Aufnahme braucht eine Ausgabe:
  Windows Graphics Capture liefert kein Bild ohne angeschlossenen, aktiven
  Schirm (Entwurf §10). Bei einem Rechner, vor dem jemand sitzt, hält der
  Mensch den Schirm wach; bei einem Standplatz-Gerät rührt sich tagelang
  niemand, und die Energieverwaltung schaltet ab. Beim ersten Weckruf käme dann
  Schwarzbild, und der Fehler sähe aus wie ein Encoder-Problem.

  Genutzt wird dieselbe Sperre, die auch das Zuschauen offenhält
  (`$lib/platform/wakeLock`) — sie ist gezählt, ein zweiter Halter stört also
  nicht. Unter Electron führt sie auf `powerSaveBlocker`
  ('prevent-display-sleep'): nur der Monitor, die Maschine darf weiter
  schlafen, wenn jemand den Deckel schliesst.

  **Was sie NICHT kann**, und was deshalb im Betriebssystem eingestellt werden
  muss (`docs/2026-08-16-standplatz-geraet-einrichten.md`):

  * Sie hält die Sperre nur, solange das Fenster sichtbar ist — ein minimiertes
    Pulse lässt den Schirm schlafen.
  * Sie verhindert kein **Sperren** des Bildschirms. Auf dem Sperrbildschirm
    existiert der Sidecar gar nicht; das ist die harte Grenze aus §10 und mit
    einem Userland-Prozess nicht zu umgehen.
-->
<script lang="ts">
  import { acquireWakeLock } from '$lib/platform/wakeLock';
  import { geraeteSlots } from '$lib/devices/wecken';
  import { gatewayForServer } from '$lib/ws/connection';
  import { geraeteAnmeldung } from '$lib/devices/anmeldung.svelte';
  import { deviceStore } from '$lib/devices/store.svelte';
  import { platzSchluessel } from '$lib/devices/platzMeldungBuch';
  import { platzMeldungen } from '$lib/devices/platzMeldung.svelte';
  import { isElectron } from '$lib/platform/runtime';

  const desktop = isElectron();

  $effect(() => {
    // Nur auf einem eingetragenen Gerät und nur in der Desktop-App: im Browser
    // gibt es keinen Sidecar, den ein wacher Schirm etwas anginge.
    //
    // **Irgendeine Eintragung, nicht die des gerade offenen Servers** (Bughunt
    // 2026-08-16): der Schirm hing an `activeServer`, und ein Server-Wechsel
    // liess ihn mitten im Betrieb wieder einschlafen — ausgerechnet dann, wenn
    // niemand davorsitzt, der ihn weckt. Ob dieser Rechner ein Standplatz ist,
    // hängt nicht daran, welche Community gerade offen ist.
    if (!desktop || geraeteAnmeldung.eintragungen.length === 0) return;
    return acquireWakeLock();
  });

  // Melden, auf welchen Plätzen dieser Rechner ALS GERÄT sendet.
  //
  // **Warum als Effekt und nicht am Ende des Weckrufs**: ein Strom kann von
  // sich aus enden — Encoder weg, Bildschirm abgesteckt, Sidecar gestorben. Am
  // Weckruf gemeldet stünde das Gerät danach dauerhaft als sendend da, und das
  // LIVE-Abzeichen bliebe an einem Rechner kleben, der längst still ist. Der
  // Effekt hängt an den laufenden Strömen und meldet jede Änderung, gleich aus
  // welchem Anlass.
  //
  // Ohne Vergleich mit dem zuletzt Gemeldeten liefe hier bei jeder
  // Zustandsänderung des Streams eine Nachricht hinaus (Bitrate, Zuschauer);
  // der Gateway verwirft Doppelte zwar, aber das Nachrichtenaufkommen wäre
  // trotzdem falsch.
  //
  // Der Merker wird **je Server** geführt und von der Anmeldung entwertet —
  // beides begründet im Kopf von `$lib/devices/platzMeldungBuch`. Jeder Server
  // wird eigenständig versorgt, ein Fehlschlag bei einem hält die übrigen
  // deshalb nicht auf (`continue`, nicht `return`).
  $effect(() => {
    const slots = geraeteSlots();
    const schluessel = platzSchluessel(slots);
    const eintragungen = geraeteAnmeldung.eintragungen;
    platzMeldungen.ausfuehren(
      eintragungen.map((e) => e.serverId),
      schluessel,
      (serverId) => {
        const e = eintragungen.find((x) => x.serverId === serverId);
        const conn = e ? gatewayForServer(serverId) : null;
        if (!e || !conn) return false;
        // **Das Ergebnis wird zurückgegeben, nicht weggeworfen.** `_sendRaw`
        // wirft nicht, wenn der Socket zu ist — es gibt `false` zurück
        // (`gateway-connection.ts`). Ein `try/catch` mit festem `return true`
        // war deshalb toter Code, und der Merker galt als gesetzt, obwohl
        // nichts hinausging: dieser Server blieb bis zum nächsten
        // Platz-Wechsel ungemeldet. Beim nächsten Durchgang erneut, spätestens
        // beim Wiederverbinden — die Neuanmeldung entwertet den Merker.
        return conn.sendDeviceStreams(e.deviceId, slots);
      },
    );
  });

  // Die eigene Gerätezeile vorladen. Sie ist der einzige Weg vom Rechner zu
  // seinem Standplatz-KANAL — die Eintragung kennt nur die Community —, und an
  // dem Kanal hängt die Dauerfreigabe „jeder" (`$lib/remote/standplatz.svelte.ts`).
  // Ohne Vorladen käme die Auflösung erst, wenn jemand die Community ansieht;
  // auf einem Standplatz-Gerät sieht sie niemand an, und die Freigabe fiele
  // fail-closed auf den Dialog zurück, den dort niemand beantwortet.
  $effect(() => {
    if (!desktop) return;
    for (const e of geraeteAnmeldung.eintragungen) void deviceStore.ensureLoaded(e.guildId);
  });
</script>
