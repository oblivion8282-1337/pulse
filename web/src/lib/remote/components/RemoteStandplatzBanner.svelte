<!--
  RemoteStandplatzBanner — die sichtbare Anzeige am freigegebenen Gerät.

  Das dritte Stück des Ersatzes für den fehlenden Zeugen (§7 des Entwurfs
  `docs/plans/2026-08-14-fernsteuerung-unbeaufsichtigte-geraete.md`): wer doch
  einmal an diesen Rechner tritt, muss auf den ersten Blick sehen, dass er
  fremden Zugriff zulässt — und ihn mit einem Klick beenden können.

  **Nicht warnfarben, und das ist Absicht.** Amber gehört der laufenden
  Übernahme (`RemoteHostBanner`). Ein freigegebenes Gerät ist kein Alarm,
  sondern ein Zustand; es trägt deshalb den entsättigten Stahlton, den auch der
  Oberflächen-Entwurf den Geräten gibt. Wären beide gleich, ginge der
  Unterschied zwischen „steht bereit" und „wird gerade gesteuert" verloren —
  und der ist der wichtigste, den dieses Fenster zu machen hat.

  **Während einer Sitzung tritt es zurück.** Dann steht das Amber-Banner da,
  das mehr sagt (wer, von wo, seit wann) und dieselbe Notbremse trägt. Zwei
  Banner übereinander hiessen zweimal dasselbe halb.
-->
<script lang="ts">
  import MonitorCogIcon from '@lucide/svelte/icons/monitor-cog';
  import { Button } from '$lib/components/ui/button/index.js';
  import { standplatz } from '$lib/remote/standplatz.svelte';
  import { remoteSession } from '$lib/remote/session.svelte';
  import { geraeteSlots, wiederEinschlafen } from '$lib/devices/wecken';
  import { isElectron } from '$lib/platform/runtime';
  import { activeServer } from '$lib/stores/active-server.svelte';
  import { geraeteAnmeldung } from '$lib/devices/anmeldung.svelte';
  import { freigaben } from '$lib/devices/freigaben.svelte';
  import { freigabenUmfang } from '$lib/devices/freigabenUmfang';
  import { m } from '$lib/paraglide/messages.js';

  const desktop = isElectron();

  // Welches Gerät dieser Rechner ist, sagt die lokale Eintragung — dieselbe
  // Quelle wie in `SettingsStandplatz.svelte`. Ohne Eintragung auf dem
  // gerade aktiven Server gibt es keine Server-Liste zu lesen; der Umfang
  // bleibt dann leer, das Banner selbst hängt weiter nur an `standplatz.aktiv`.
  const eintragung = $derived(geraeteAnmeldung.fuerServer(activeServer.serverId));
  $effect(() => {
    if (eintragung) void freigaben.laden(eintragung.guildId, eintragung.deviceId);
  });
  const umfang = $derived(
    freigabenUmfang(eintragung ? freigaben.fuer(eintragung.deviceId) : []),
  );

  /** Zurücknehmen ist zweiteilig, und die Reihenfolge ist wichtig: zuerst der
   *  lokale Hauptschalter (`standplatz.zuruecknehmen()`, wirkt sofort und auch
   *  ohne Netz), erst danach die Server-Liste leeren. Der umgekehrte Weg liesse
   *  das Gerät bei einem Netzfehler beim zweiten Schritt scharf stehen. Bricht
   *  das Leeren ab, bekommt der Nutzer das gesagt — die lokale Sperre gilt
   *  trotzdem schon. */
  let leerenFehler = $state<string | null>(null);
  async function zuruecknehmen(): Promise<void> {
    leerenFehler = null;
    await standplatz.zuruecknehmen();
    if (!eintragung) return;
    try {
      await freigaben.setzen(eintragung.guildId, eintragung.deviceId, []);
    } catch (e) {
      leerenFehler = e instanceof Error ? e.message : String(e);
    }
  }

  /**
   * Überträgt dieser Rechner gerade, weil ihn jemand geweckt hat?
   *
   * **Der Fehlerfall** (2026-08-16): jemand weckt das Gerät, der Besitzer lehnt
   * die Übernahme ab — und der Rechner überträgt weiter, ohne dass es dafür
   * eine Schaltfläche gäbe. Die Ströme gehören dem Weckruf, nicht dem Besitzer;
   * sie tauchen deshalb in seinen gewohnten Bedienelementen nicht auf, und die
   * Nachlauf-Wache greift erst nach 90 Sekunden. Ein unbeaufsichtigter Rechner,
   * der ungefragt weitersendet, braucht einen Ausschalter, der immer da ist.
   */
  const geweckt = $derived(geraeteSlots().length);

  // Das Banner steht jetzt aus zwei Gründen: freigegeben (der bisherige) ODER
  // geweckt. Der zweite gilt auch ohne Dauerfreigabe — gerade dann ist er
  // wichtig, denn dort ist gerade eine Übernahme abgelehnt worden.
  let show = $derived(
    desktop && (standplatz.aktiv || geweckt > 0) && remoteSession.phase !== 'active',
  );

</script>

{#if show}
  {@const restStunden = standplatz.restStunden()}
  <div
    class="border-border bg-bg-input/90 fixed left-1/2 top-3 z-[55] flex -translate-x-1/2
      items-center gap-3 rounded-xl border px-4 py-2 shadow-lg backdrop-blur"
    role="status"
    data-testid="remote-standplatz-banner"
  >
    <span class="text-text-muted grid size-7 place-items-center rounded-lg">
      <MonitorCogIcon class="size-4" />
    </span>
    <span class="min-w-0">
      <span class="text-text-bright block truncate text-sm font-medium">
        {geweckt > 0 ? m.standplatz_banner_streaming() : m.standplatz_banner_title()}
      </span>
      <span class="text-text-muted block truncate text-xs">
        {umfang.jeder
          ? m.standplatz_banner_scope_everyone()
          : m.standplatz_banner_scope_users({ count: umfang.anzahl })}
        ·
        {restStunden === null
          ? m.standplatz_banner_permanent()
          : m.standplatz_banner_until_hours({ hours: restStunden })}
      </span>
      {#if leerenFehler}
        <span class="text-destructive block truncate text-xs" data-testid="remote-standplatz-banner-error">
          {m.standplatz_banner_clear_failed()}
        </span>
      {/if}
    </span>
    {#if geweckt > 0}
      <Button
        size="sm"
        variant="destructive"
        onclick={() => void wiederEinschlafen('vom Besitzer am Gerät beendet')}
        data-testid="remote-standplatz-banner-stop"
      >
        {m.standplatz_banner_stop()}
      </Button>
    {/if}
    {#if standplatz.aktiv}
      <Button
        size="sm"
        variant="outline"
        onclick={() => void zuruecknehmen()}
        data-testid="remote-standplatz-banner-revoke"
      >
        {m.standplatz_banner_revoke()}
      </Button>
    {/if}
  </div>
{/if}
