<!--
  SettingsStandplatz — der Reiter „Remote-Rechner", zwei Abschnitte.

  **Dieser Rechner**: die Karte mit Schalter und Freigaben
  (`SettingsStandplatzRechner`, über die Lage-Weiche in
  `SettingsGeraeteEintragung`), darunter zugeklappt das Übertragungsprofil und
  das Protokoll. **Meine Remote-Rechner**: die Liste aller eigenen Geräte auf
  diesem Server (`SettingsStandplatzGeraete`) — sie läuft unabhängig davon, ob
  DIESER Rechner Standplatz sein kann, weil man Geräte besitzen kann, ohne an
  einem zu sitzen. Das ist auch der Grund, warum der Reiter nicht nur unter
  Windows sichtbar ist (`reiterSichtbar.ts`).

  **Vor dem 2026-09-09 standen hier sieben Karten**, und drei Dinge doppelt:
  das eigene Gerät (in der Liste UND unter „Eingetragen als", mit zwei
  Lösch-Knöpfen), die Frage „wie lange" (am Hauptschalter UND je
  Freigabe-Zeile) und die Verwaltung (hier UND in der Geräteansicht im
  Kanal). Entwurf und Begründungen der Standplatz-Geräte:
  `docs/plans/2026-08-14-fernsteuerung-unbeaufsichtigte-geraete.md`.

  **Der Schalter braucht die Desktop-App, der Reiter selbst nicht.**
  Ferngesteuert werden kann ausschliesslich ein Rechner mit lokalem Sidecar;
  im Browser wäre der Schalter eine Zusage, die niemand einlöst — der
  `{#if !desktop}`-Zweig zeigt dort nur den Hinweis. Die Liste der eigenen
  Geräte braucht keinen Sidecar und steht in jedem Zweig.
-->
<script lang="ts">
  import SlidersIcon from '@lucide/svelte/icons/sliders-horizontal';
  import ScrollTextIcon from '@lucide/svelte/icons/scroll-text';
  import SettingsGeraeteEintragung from './SettingsGeraeteEintragung.svelte';
  import SettingsStandplatzBerechtigung from './SettingsStandplatzBerechtigung.svelte';
  import SettingsStandplatzKlappe from './SettingsStandplatzKlappe.svelte';
  import SettingsStandplatzProfil from './SettingsStandplatzProfil.svelte';
  import SettingsStandplatzProtokoll, { protokollZeile } from './SettingsStandplatzProtokoll.svelte';
  import SettingsStandplatzGeraete from './SettingsStandplatzGeraete.svelte';
  import { activeServer } from '$lib/stores/active-server.svelte';
  import { deviceStore } from '$lib/devices/store.svelte';
  import { geraeteAnmeldung } from '$lib/devices/anmeldung.svelte';
  import { standplatzProfil, HAUPTBILDSCHIRM } from '$lib/devices/profil.svelte';
  import { profilZusammenfassung } from '$lib/devices/profilZusammenfassung';
  import { remoteProtokoll } from '$lib/remote/protokoll.svelte';
  import { streamSettings } from '$lib/stream/settings.svelte';
  import { MONITOR_CAPTURE_PREFIX } from '$lib/stream/settingsCatalog';
  import { isElectron } from '$lib/platform/runtime';
  import { darfStandplatzSein } from '$lib/remote/darfStandplatzSein';
  import { m } from '$lib/paraglide/messages.js';

  const desktop = isElectron();
  // Kann sich dieser Rechner ueberhaupt steuern lassen? Dieselbe Bedingung
  // wie beim Reiter-Gate und bei der Anmeldung (`darfStandplatzSein`).
  //
  // **`$derived`, nicht einmalig beim Einhaengen.** Die Faehigkeit kommt aus
  // `health.gsr.remote_input` und trifft erst nach einem IPC-Umlauf ein — eine
  // Momentaufnahme beim Einhaengen zeigte auf einem langsamen Start dauerhaft
  // „geht nicht", obwohl es geht. Auf macOS ist der Wert ausserdem wechselhaft:
  // eine zurueckgezogene Systemfreigabe muss hier ankommen.
  const kannStandplatz = $derived(darfStandplatzSein());

  const eintragung = $derived(geraeteAnmeldung.fuerServer(activeServer.serverId));
  const eingetragen = $derived(
    !!eintragung && deviceStore.byId(eintragung.guildId, eintragung.deviceId) !== null,
  );
  $effect(() => {
    if (eintragung) void deviceStore.ensureLoaded(eintragung.guildId);
  });

  /** Der Name der Aufnahmequelle für die Zusammenfassung — „Hauptbildschirm"
   *  oder der gemeldete Monitorname; fehlt die Liste, die rohe Kennung. */
  const quelleName = $derived.by(() => {
    const q = standplatzProfil.profil.quelle;
    if (q === HAUPTBILDSCHIRM) return m.standplatz_profil_source_primary();
    const mon = streamSettings.available_monitors.find(
      (mm) => `${MONITOR_CAPTURE_PREFIX}${mm.index}` === q,
    );
    return mon?.name ?? q;
  });
  const profilZeile = $derived(
    profilZusammenfassung({
      ...standplatzProfil.profil,
      quelleName,
      aufloesungNativ: m.standplatz_profil_resolution_native(),
    }),
  );
</script>

<div class="flex flex-col gap-5">
  <span class="text-text-muted text-xs font-semibold tracking-wide uppercase">
    {m.standplatz_section_this()}
  </span>

  {#if !desktop}
    <p class="border-border text-text-muted rounded-2xl border border-dashed p-4 text-sm">
      {m.standplatz_settings_desktop_only()}
    </p>
  {:else if !kannStandplatz}
    <!-- Desktop, aber ohne Gegenstelle (Linux/macOS). Hier steht bewusst NUR
         der Hinweis und die Eintragung: Profil und Freigaben richteten etwas
         ein, das dieser Rechner nicht einloesen kann. Die Eintragung bleibt,
         weil sie der einzige Weg ist, eine unter Windows angelegte Zeile
         wieder loszuwerden. -->
    <p class="border-border text-text-muted rounded-2xl border border-dashed p-4 text-sm">
      {m.standplatz_settings_platform_only()}
    </p>
    <!-- Der Grund, falls der Sidecar einen nennt. Heute tut das nur macOS, wo
         zwei getrennte Systemfreigaben noetig sind und die zweite fast immer
         fehlt, weil niemand sie erwartet. Ohne diesen Block bliebe es bei
         „geht nicht" ohne Weg nach vorn. -->
    <SettingsStandplatzBerechtigung />
    <SettingsGeraeteEintragung steuerbar={false} />
  {:else}
    <SettingsGeraeteEintragung steuerbar={true} />
    {#if eingetragen}
      <SettingsStandplatzKlappe
        icon={SlidersIcon}
        title={m.standplatz_profil_title()}
        summary={profilZeile}
        testid="standplatz-profil"
      >
        <SettingsStandplatzProfil />
      </SettingsStandplatzKlappe>
      <SettingsStandplatzKlappe
        icon={ScrollTextIcon}
        title={m.standplatz_settings_log()}
        summary={protokollZeile(remoteProtokoll.eintraege)}
        testid="standplatz-protokoll"
      >
        <SettingsStandplatzProtokoll />
      </SettingsStandplatzKlappe>
    {/if}
  {/if}

  <span class="text-text-muted text-xs font-semibold tracking-wide uppercase">
    {m.device_settings_my_devices_title()}
  </span>
  <SettingsStandplatzGeraete />
</div>
