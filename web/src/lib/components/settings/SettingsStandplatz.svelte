<!--
  SettingsStandplatz — der Standplatz-Reiter, als Klammer um vier Themen.

  Der Schalter, mit dem aus einem gewöhnlichen Rechner ein Standplatz-Gerät
  wird: einmal freigeben, danach beantwortet dieser Client Fernsteuer-Anfragen
  selbst (`$lib/remote/standplatz.svelte.ts`). Entwurf und Begründungen:
  `docs/plans/2026-08-14-fernsteuerung-unbeaufsichtigte-geraete.md`.

  **Vier Themen, vier Dateien** (Zerlegung Aufgabe 10, Grenze 250 Zeilen):
  hier bleiben nur der Hauptschalter (Zustand + wie lange er gilt) und die
  Weichen, welches Thema überhaupt zu sehen ist. `SettingsStandplatzFreigabe`
  trägt die WEM-Frage (seit 2026-08-20 serverseitig, `DeviceFreigaben` aus
  Aufgabe 9), `SettingsStandplatzProfil` das Übertragungsprofil,
  `SettingsStandplatzProtokoll` das Protokoll vergangener Übernahmen.

  **„Meine Geräte" (`SettingsStandplatzGeraete`) läuft unabhängig von
  `kannStandplatz`** — sie zeigt nicht, ob DIESER Rechner Standplatz sein kann,
  sondern welche Geräte diesem NUTZER auf diesem Server gehören. Das ist auch
  der Grund, warum der Reiter selbst seit 2026-08-20 nicht mehr nur unter
  Windows sichtbar ist (`reiterSichtbar.ts`).

  **Nur in der Desktop-App.** Ferngesteuert werden kann ausschliesslich ein
  Rechner mit lokalem Sidecar; im Browser wäre der Schalter eine Zusage, die
  niemand einlöst. Der Tab ist deshalb `electronOnly` (SettingsDialog), und
  dieser Hinweis ist das Netz, falls er doch einmal woanders landet.
-->
<script lang="ts">
  import MonitorCogIcon from '@lucide/svelte/icons/monitor-cog';
  import SettingsGeraeteEintragung from './SettingsGeraeteEintragung.svelte';
  import SettingsStandplatzFreigabe from './SettingsStandplatzFreigabe.svelte';
  import SettingsStandplatzProfil from './SettingsStandplatzProfil.svelte';
  import SettingsStandplatzProtokoll from './SettingsStandplatzProtokoll.svelte';
  import SettingsStandplatzGeraete from './SettingsStandplatzGeraete.svelte';
  import { Button } from '$lib/components/ui/button/index.js';
  import { Input } from '$lib/components/ui/input/index.js';
  import { spanneMs, standplatz, type Einheit, type Geltung } from '$lib/remote/standplatz.svelte';
  import { activeServer } from '$lib/stores/active-server.svelte';
  import { deviceStore } from '$lib/devices/store.svelte';
  import { geraeteAnmeldung } from '$lib/devices/anmeldung.svelte';
  import { isElectron } from '$lib/platform/runtime';
  import { darfStandplatzSein } from '$lib/remote/darfStandplatzSein';
  import { m } from '$lib/paraglide/messages.js';

  const desktop = isElectron();
  // Kann sich dieser Rechner ueberhaupt steuern lassen? Dieselbe Bedingung
  // wie beim Reiter-Gate und bei der Anmeldung (`darfStandplatzSein`).
  const kannStandplatz = darfStandplatzSein();

  // Die Spanne für „befristet". Vorgabe acht Stunden — ein Arbeitstag, der
  // frühere Festwert; jetzt bloss der Startpunkt statt der einzigen Wahl.
  let geltung = $state<Geltung>(standplatz.geltung);
  let menge = $state(8);
  let einheit = $state<Einheit>('stunden');

  /**
   * Die laufende Uhr für die Restanzeige.
   *
   * **Halbminütlich und nicht sekündlich**: Chromium drosselt Zeitgeber in
   * verdeckten Fenstern auf einen Lauf je Minute — genau die Lage eines
   * Standplatz-Rechners. Ein Sekunden-Countdown sähe dort aus wie ein Fehler,
   * weil er in Sprüngen liefe. Die Anzeige nennt deshalb das **Ende** (das wird
   * nie falsch) und dazu eine grobe Restzeit.
   */
  let jetzt = $state(Date.now());
  $effect(() => {
    const t = setInterval(() => (jetzt = Date.now()), 30_000);
    return () => clearInterval(t);
  });

  /** Restzeit in der gröbsten Einheit, die noch etwas sagt. */
  const restText = $derived.by(() => {
    const bis = standplatz.gueltigBis;
    if (bis === null) return null;
    const ms = Math.max(0, bis - jetzt);
    const minuten = Math.round(ms / 60_000);
    if (minuten < 60) return m.standplatz_rest_minutes({ count: Math.max(1, minuten) });
    const stunden = Math.round(minuten / 60);
    if (stunden < 48) return m.standplatz_rest_hours({ count: stunden });
    return m.standplatz_rest_days({ count: Math.round(stunden / 24) });
  });

  /** Das Ende als Datum und Uhrzeit — die Angabe, die nicht altert. */
  const endeText = $derived(
    standplatz.gueltigBis === null ? null : new Date(standplatz.gueltigBis).toLocaleString(),
  );

  const geltungen: { id: Geltung; label: () => string }[] = [
    { id: 'befristet', label: m.standplatz_settings_duration_limited },
    { id: 'dauerhaft', label: m.standplatz_settings_duration_permanent },
  ];

  const einheiten: { id: Einheit; label: () => string }[] = [
    { id: 'stunden', label: m.standplatz_settings_unit_hours },
    { id: 'tage', label: m.standplatz_settings_unit_days },
    { id: 'wochen', label: m.standplatz_settings_unit_weeks },
  ];

  async function freigeben(): Promise<void> {
    // Die Zahl wird hier geklemmt und nicht erst im Speicher: ein geleertes
    // Zahlenfeld schreibt über `bind:value` ein `null`, und daraus würde sonst
    // ein Ablauf in der Vergangenheit (dieselbe Falle wie im Übertragungs-Profil).
    const zahl = Number.isFinite(Number(menge)) && Number(menge) > 0 ? Number(menge) : 1;
    // Die Empfänger entscheidet seit 2026-08-20 der Server (`device_grants`,
    // s. `SettingsStandplatzFreigabe`) — hier bleibt nur der Hauptschalter,
    // deshalb `jeder: true`: lokal soll nichts mehr einschränken, was der
    // Server ohnehin über `selbsttaetigRegel.ts` prüft.
    await standplatz.freigeben({
      nutzer: standplatz.nutzer,
      jeder: true,
      geltung,
      dauerMs: spanneMs(zahl, einheit),
    });
  }

  const eintragung = $derived(geraeteAnmeldung.fuerServer(activeServer.serverId));
  const standplatzGeraet = $derived(
    eintragung ? deviceStore.byId(eintragung.guildId, eintragung.deviceId) : null,
  );
  $effect(() => {
    if (eintragung) void deviceStore.ensureLoaded(eintragung.guildId);
  });
</script>

<div class="flex flex-col gap-5">
  <SettingsStandplatzGeraete />

  {#if !desktop}
    <p class="border-border text-text-muted rounded-2xl border border-dashed p-4 text-sm">
      {m.standplatz_settings_desktop_only()}
    </p>
  {:else if !kannStandplatz}
    <!-- Desktop, aber ohne Gegenstelle (Linux/macOS). Hier steht bewusst NUR
         der Hinweis und die Eintragung: alles andere — Dauerfreigabe,
         Standplatz-Profil, Berechtigte — richtet etwas ein, das dieser Rechner
         nicht einloesen kann. Die Eintragung bleibt, weil sie der einzige Weg
         ist, eine unter Windows angelegte Zeile wieder loszuwerden. -->
    <p class="border-border text-text-muted rounded-2xl border border-dashed p-4 text-sm">
      {m.standplatz_settings_platform_only()}
    </p>
    <SettingsGeraeteEintragung />
  {:else}
    <!-- Zustand -->
    <div class="border-border flex items-center gap-3 rounded-2xl border p-4">
      <span class="bg-bg-input grid size-9 shrink-0 place-items-center rounded-lg">
        <MonitorCogIcon
          class={standplatz.aktiv ? 'size-5 text-emerald-500' : 'text-text-muted size-5'}
        />
      </span>
      <span class="min-w-0 flex-1">
        <span class="text-text-bright block text-sm font-semibold" data-testid="standplatz-state">
          {standplatz.aktiv ? m.standplatz_settings_state_on() : m.standplatz_settings_state_off()}
        </span>
        {#if standplatz.aktiv}
          <span class="text-text-muted block text-xs">
            {endeText === null
              ? m.standplatz_banner_permanent()
              : `${m.standplatz_until({ zeitpunkt: endeText })} · ${restText}`}
          </span>
        {/if}
      </span>
      <!-- **Der Zustand ist der Schalter.** Freigeben und Aufheben sind dieselbe
           Entscheidung in zwei Richtungen; sie gehören deshalb an dieselbe
           Stelle — dorthin, wo steht, wie es gerade steht. -->
      {#if standplatz.aktiv}
        <Button
          size="sm"
          variant="destructive"
          onclick={() => standplatz.zuruecknehmen()}
          data-testid="standplatz-revoke"
        >
          {m.standplatz_settings_revoke()}
        </Button>
      {:else}
        <Button size="sm" onclick={freigeben} data-testid="standplatz-grant">
          {m.standplatz_settings_grant()}
        </Button>
      {/if}
    </div>

    <!-- Wie lange -->
    <div class="border-border flex flex-col gap-2 rounded-2xl border p-4">
      <span class="text-text-bright text-sm font-medium">{m.standplatz_settings_duration()}</span>
      <div class="flex flex-wrap gap-2">
        {#each geltungen as g (g.id)}
          <Button
            size="sm"
            variant={geltung === g.id ? 'default' : 'outline'}
            onclick={() => (geltung = g.id)}
            data-testid={`standplatz-duration-${g.id}`}
          >
            {g.label()}
          </Button>
        {/each}
      </div>
      {#if geltung === 'befristet'}
        <div class="flex items-center gap-2">
          <Input
            type="number"
            min="1"
            max="999"
            class="w-24"
            bind:value={menge}
            data-testid="standplatz-duration-amount"
          />
          <select
            class="border-border bg-bg-input text-text-bright rounded-lg border px-2 py-1.5 text-sm"
            bind:value={einheit}
            data-testid="standplatz-duration-unit"
          >
            {#each einheiten as e (e.id)}
              <option value={e.id}>{e.label()}</option>
            {/each}
          </select>
        </div>
      {/if}
    </div>

    <SettingsGeraeteEintragung />
    <SettingsStandplatzFreigabe device={standplatzGeraet} />
    <SettingsStandplatzProfil />
    <SettingsStandplatzProtokoll />
  {/if}
</div>
