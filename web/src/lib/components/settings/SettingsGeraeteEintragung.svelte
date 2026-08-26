<!--
  SettingsGeraeteEintragung — in welchem Zustand ist die Standplatz-Eintragung
  dieses Rechners, und was gehört dazu angezeigt?

  Das Gegenstück zur Dauerfreigabe nebenan: die gibt den Rechner **frei**, das
  hier gibt ihm einen **Ort**. Beides steht im selben Reiter, weil nur beides
  zusammen einen Standplatz ergibt — freigegeben und nirgends auffindbar ist so
  nutzlos wie eingetragen und für niemanden freigegeben.

  **Vier Zustände, nicht zwei** (Bughunt 2026-08-21). Bis dahin fragte diese
  Datei nur, ob eine lokale Eintragung vorliegt, und zeigte danach entweder das
  Eintragen-Formular oder eine Verwaltung. Der Fall „Eintragung liegt vor, aber
  der Server liefert keine Gerätezeile dazu" fiel damit auf den zweiten: der
  Reiter zeigte ein Kanalfeld ohne Inhalt, ausgegraut, ohne Hinweis — und das
  Eintragen-Formular blieb verborgen, obwohl genau das gebraucht wurde. Von
  aussen sah das aus wie „ich kann nichts auswählen". Die Unterscheidung steht
  in `eintragungLage.ts` und ist dort geprüft; hier bleibt die Anzeige.

  **Die Verwaltung ist geliehen, nicht nachgebaut.** `DeviceVerwaltung` kann
  Umbenennen, Kanal- und Community-Wechsel und Entfernen bereits — und zwar
  vollständiger als die frühere Fassung hier, der der Community-Wechsel ganz
  fehlte (aus diesem Reiter kam man nur in einen anderen Kanal DERSELBEN
  Community). Dieselbe Entscheidung wie bei `SettingsStandplatzFreigabe`: die
  Oberfläche für Standplatz-Geräte gibt es EINMAL.

  **Der verwaiste Zustand hat bewusst nur einen Ausgang, und der ist lokal.**
  Ist die Community weg, antwortet jede Geräte-Route mit 403 (`require_member`)
  — es gibt dann keinen Ruf, der die Sackgasse öffnen könnte. Der Knopf sagt
  deshalb, was er tut: er entfernt die Behauptung dieses Rechners, nicht die
  Zeile auf dem Server.
-->
<script lang="ts">
  import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
  import { Button } from '$lib/components/ui/button/index.js';
  import DeviceVerwaltung from '$lib/devices/components/DeviceVerwaltung.svelte';
  import SettingsGeraeteEintragungNeu from './SettingsGeraeteEintragungNeu.svelte';
  import { deviceStore } from '$lib/devices/store.svelte';
  import { geraeteAnmeldung } from '$lib/devices/anmeldung.svelte';
  import { geraeteVerwaltung } from '$lib/devices/verwaltung.svelte';
  import { eintragungLage } from '$lib/devices/eintragungLage';
  import { guilds } from '$lib/stores/guilds.svelte';
  import { activeServer } from '$lib/stores/active-server.svelte';
  import { m } from '$lib/paraglide/messages.js';

  const serverId = $derived(activeServer.serverId);
  const eintragung = $derived(geraeteAnmeldung.fuerServer(serverId));

  /**
   * Die eigene Gerätezeile — sie kennt den aktuellen Standplatz, die Eintragung
   * kennt nur die Community. Vorgeladen, weil auf einem Standplatz-Gerät
   * niemand die Community ansieht (dieselbe Begründung wie in `DeviceKiosk`).
   */
  const geraet = $derived(
    eintragung ? deviceStore.byId(eintragung.guildId, eintragung.deviceId) : null,
  );
  $effect(() => {
    if (!eintragung) return;
    void deviceStore.ensureLoaded(eintragung.guildId);
    // **Und die Kanäle dieser Community.** Bis 2026-08-21 verliess sich diese
    // Datei darauf, dass `SettingsStandplatzGeraete` weiter oben im Reiter für
    // JEDE Community nachlädt. Das galt nur, solange die Community auch in
    // `guilds.list` steht — bei einer verlassenen eben nicht, und dann blieb
    // die Kanalauswahl ohne Grund leer.
    void guilds.ensureChannels(eintragung.guildId).catch(() => undefined);
  });

  /**
   * Eingetragen, verwaist, lädt noch, oder gar nicht eingetragen.
   *
   * `guilds.loaded` ist gesetzt, sobald der `ready`-Rahmen die Communityliste
   * dieses Servers geseedet hat — sie ist dort die alleinige Wahrheit, und nur
   * deshalb darf „Community nicht enthalten" hier als Nachweis gelten.
   */
  const lage = $derived(
    eintragungLage({
      hatEintragung: !!eintragung,
      geraetGefunden: !!geraet,
      communityListeGeladen: guilds.loaded,
      communityBekannt: !!eintragung && !!guilds.byId[eintragung.guildId],
      geraeteListeGeladen: !!eintragung && deviceStore.istGeladen(eintragung.guildId),
    }),
  );

  function verwaistVergessen(): void {
    if (eintragung) void geraeteVerwaltung.nurLokalVergessen(eintragung.deviceId);
  }
</script>

<div class="flex flex-col gap-3">
  {#if lage === 'eingetragen' && geraet}
    <span class="text-text-muted text-xs">
      {m.device_settings_registered_title()}
      <span class="text-text-bright font-medium">{geraet.name}</span>
    </span>
    <!-- `darfVerwalten={false}`: Verwaltungs-Rechte spielen hier keine Rolle —
         dies ist der eigene Rechner, und Besitzer ist man. -->
    <DeviceVerwaltung device={geraet} />
  {:else if lage === 'verwaist'}
    <div
      class="border-border flex flex-col gap-3 rounded-2xl border p-4"
      data-testid="device-register-orphan"
    >
      <span class="text-text-bright flex items-center gap-2 text-sm font-semibold">
        <TriangleAlertIcon class="size-4 text-amber-500" />
        {m.device_settings_orphan_title()}
      </span>
      <p class="text-text-muted text-xs">
        {m.device_settings_orphan_hint({ name: eintragung?.name ?? '' })}
      </p>
      <div class="flex justify-end">
        <Button
          size="sm"
          variant="destructive"
          onclick={verwaistVergessen}
          data-testid="device-register-orphan-forget"
        >
          {m.device_settings_orphan_forget()}
        </Button>
      </div>
    </div>
  {:else if lage === 'laedt'}
    <p class="border-border text-text-muted rounded-2xl border border-dashed p-4 text-xs">
      {m.device_settings_register_checking()}
    </p>
  {:else}
    <SettingsGeraeteEintragungNeu {serverId} />
  {/if}
</div>
