<!--
  SettingsStandplatz — Dauerfreigabe und Protokoll des Geräts.

  Der Schalter, mit dem aus einem gewöhnlichen Rechner ein Standplatz-Gerät
  wird: einmal freigeben, danach beantwortet dieser Client Fernsteuer-Anfragen
  selbst (`$lib/remote/standplatz.svelte.ts`). Entwurf und Begründungen:
  `docs/plans/2026-08-14-fernsteuerung-unbeaufsichtigte-geraete.md`.

  **Freigabe und Protokoll stehen absichtlich im selben Bild** (§7 des
  Entwurfs). Bei einem beaufsichtigten Rechner ist die eigentliche Sicherheit,
  dass jemand danebensitzt; hier fällt der Zeuge weg, und das Protokoll tritt an
  seine Stelle. In einem Untermenü wäre es eine Alibi-Funktion.

  **Nur in der Desktop-App.** Ferngesteuert werden kann ausschliesslich ein
  Rechner mit lokalem Sidecar; im Browser wäre der Schalter eine Zusage, die
  niemand einlöst. Der Tab ist deshalb `electronOnly` (SettingsDialog), und
  dieser Hinweis ist das Netz, falls er doch einmal woanders landet.
-->
<script lang="ts">
  import MonitorCogIcon from '@lucide/svelte/icons/monitor-cog';
  import ShieldCheckIcon from '@lucide/svelte/icons/shield-check';
  import ScrollTextIcon from '@lucide/svelte/icons/scroll-text';
  import XIcon from '@lucide/svelte/icons/x';
  import Checkbox from '$lib/components/form/Checkbox.svelte';
  import { Button } from '$lib/components/ui/button/index.js';
  import { standplatz, type Geltung } from '$lib/remote/standplatz.svelte';
  import { remoteProtokoll } from '$lib/remote/protokoll.svelte';
  import { gegenstelle } from '$lib/remote/gegenstelle';
  import { userCache } from '$lib/stores/users.svelte';
  import { isElectron } from '$lib/platform/runtime';
  import { m } from '$lib/paraglide/messages.js';
  import { devicesApi } from '$lib/api/devices';
  import { deviceStore } from '$lib/devices/store.svelte';
  import { geraeteAnmeldung } from '$lib/devices/anmeldung.svelte';
  import { guilds } from '$lib/stores/guilds.svelte';
  import { activeServer } from '$lib/stores/active-server.svelte';
  import { gatewayForServer } from '$lib/ws/connection';
  import { Input } from '$lib/components/ui/input/index.js';

  const desktop = isElectron();

  // Entwurf im Formular, erst „Freigeben" schreibt ihn fest. Ohne diese
  // Trennung stünde das Gerät schon scharf, während jemand noch die
  // Geltungsdauer sucht.
  let jeder = $state(standplatz.jeder);
  let geltung = $state<Geltung>(standplatz.geltung === 'neustart' ? 'acht_stunden' : standplatz.geltung);

  // Namen der einzeln Freigegebenen nachladen — sonst steht dort die nackte
  // Kennung, und niemand erkennt, wen er da freigegeben hat.
  $effect(() => {
    for (const id of standplatz.nutzer) userCache.queue(id);
  });

  const restStunden = $derived.by(() => {
    const rest = standplatz.restMs();
    return rest === null || rest === 0 ? null : Math.max(1, Math.round(rest / 3_600_000));
  });

  const geltungen: { id: Geltung; label: () => string }[] = [
    { id: 'neustart', label: m.standplatz_settings_duration_restart },
    { id: 'acht_stunden', label: m.standplatz_settings_duration_hours },
    { id: 'dauerhaft', label: m.standplatz_settings_duration_permanent },
  ];

  async function freigeben(): Promise<void> {
    await standplatz.freigeben({ nutzer: standplatz.nutzer, jeder, geltung });
  }

  async function entfernen(id: string): Promise<void> {
    const rest = standplatz.nutzer.filter((n) => n !== id);
    // Über denselben Weg wie das Freigeben: bleibt danach niemand übrig und ist
    // „jeder" aus, nimmt `freigeben` die Freigabe von selbst zurück — eine
    // scharfe Freigabe ohne Empfänger wäre eine Anzeige, die lügt.
    if (standplatz.aktiv) await standplatz.freigeben({ nutzer: rest, jeder, geltung });
    else await standplatz.freigeben({ nutzer: rest, jeder: false, geltung });
  }

  function dauer(beginn: number, ende: number | null): string {
    if (ende === null) return m.standplatz_settings_log_running();
    const ms = ende - beginn;
    if (ms <= 0) return m.standplatz_settings_log_unknown_duration();
    const minuten = Math.round(ms / 60_000);
    return minuten < 60 ? `${Math.max(1, minuten)} min` : `${Math.round(minuten / 60)} h`;
  }

  function zeitpunkt(ms: number): string {
    return new Date(ms).toLocaleString();
  }

  // ── Eintragung dieses Rechners als Standplatz-Gerät ───────────────────────
  //
  // Das Gegenstück zur Dauerfreigabe: die gibt den Rechner FREI, das hier gibt
  // ihm einen ORT. Beides gehört in dasselbe Bild, weil beides nur zusammen
  // einen Standplatz ergibt — freigegeben und nirgends auffindbar ist so
  // nutzlos wie eingetragen und für niemanden freigegeben.

  const serverId = $derived(activeServer.serverId);
  const eintragung = $derived(geraeteAnmeldung.fuerServer(serverId));

  let zielGuild = $state('');
  let zielKanal = $state('');
  let geraetName = $state('');
  let eintragBusy = $state(false);
  let eintragFehler = $state<string | null>(null);

  const sprachkanaele = $derived(
    (guilds.channelsByGuild[zielGuild] ?? []).filter((c) => c.type === 1),
  );

  async function eintragen(): Promise<void> {
    if (!serverId || !zielGuild || !zielKanal || !geraetName.trim()) return;
    eintragBusy = true;
    eintragFehler = null;
    try {
      const device = await devicesApi.create(zielGuild, {
        channel_id: zielKanal,
        name: geraetName.trim(),
      });
      await geraeteAnmeldung.merken({
        serverId,
        guildId: device.guild_id,
        deviceId: device.id,
        name: device.name,
      });
      // Sofort anmelden statt auf das nächste `ready` zu warten: sonst stünde
      // der frisch eingetragene Rechner bis zum nächsten Verbindungsaufbau als
      // „offline" in der Liste — direkt nachdem jemand ihn eingetragen hat, ist
      // das die verwirrendste mögliche Auskunft.
      gatewayForServer(serverId)?.sendDeviceAnnounce(device.id);
      deviceStore._changed(device.guild_id, device, false);
      geraetName = '';
    } catch (e) {
      eintragFehler = e instanceof Error ? e.message : String(e);
    } finally {
      eintragBusy = false;
    }
  }

  async function austragen(): Promise<void> {
    const e = eintragung;
    if (!e || !serverId) return;
    eintragBusy = true;
    eintragFehler = null;
    try {
      // ERST abmelden, DANN entfernen: nach dem Löschen findet der Server die
      // Zeile nicht mehr und könnte den Eintrag aus den Listen der anderen
      // nicht mehr benennen.
      gatewayForServer(serverId)?.sendDeviceWithdraw(e.deviceId);
      await devicesApi.remove(e.guildId, e.deviceId);
      await geraeteAnmeldung.vergessen(e.deviceId);
    } catch (err) {
      eintragFehler = err instanceof Error ? err.message : String(err);
    } finally {
      eintragBusy = false;
    }
  }
</script>

<div class="flex flex-col gap-5">
  <p class="text-text-muted text-sm">{m.standplatz_settings_intro()}</p>

  {#if !desktop}
    <p class="border-border text-text-muted rounded-2xl border border-dashed p-4 text-sm">
      {m.standplatz_settings_desktop_only()}
    </p>
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
            {standplatz.jeder
              ? m.standplatz_banner_scope_everyone()
              : m.standplatz_banner_scope_users({ count: standplatz.nutzer.length })}
            ·
            {restStunden === null
              ? m.standplatz_banner_permanent()
              : m.standplatz_banner_until_hours({ hours: restStunden })}
          </span>
        {/if}
      </span>
      {#if standplatz.aktiv}
        <Button
          size="sm"
          variant="destructive"
          onclick={() => standplatz.zuruecknehmen()}
          data-testid="standplatz-revoke"
        >
          {m.standplatz_settings_revoke()}
        </Button>
      {/if}
    </div>

    <!-- Wer -->
    <div class="border-border flex flex-col gap-3 rounded-2xl border p-4">
      <span class="text-text-bright flex items-center gap-2 text-sm font-semibold">
        <ShieldCheckIcon class="size-4" />
        {m.standplatz_settings_who()}
      </span>

      <label class="flex items-start gap-3">
        <Checkbox class="mt-0.5 shrink-0" bind:checked={jeder} data-testid="standplatz-everyone" />
        <span class="flex min-w-0 flex-1 flex-col gap-1">
          <span class="text-text-bright text-sm font-medium">
            {m.standplatz_settings_everyone()}
          </span>
          <span class="text-text-muted text-xs">{m.standplatz_settings_everyone_hint()}</span>
        </span>
      </label>

      <div class="border-border/60 flex flex-col gap-2 border-t pt-3">
        <span class="text-text-bright text-sm font-medium">
          {m.standplatz_settings_users_label()}
        </span>
        <span class="text-text-muted text-xs">{m.standplatz_settings_users_hint()}</span>
        {#if standplatz.nutzer.length === 0}
          <span class="text-text-muted text-xs italic">{m.standplatz_settings_users_empty()}</span>
        {:else}
          <ul class="flex flex-col gap-1.5">
            {#each standplatz.nutzer as id (id)}
              {@const wer = gegenstelle(id)}
              <li class="flex items-center gap-2">
                <span class="text-text-base min-w-0 flex-1 truncate text-sm">
                  {wer.anzeige}{wer.benutzername ? ` · @${wer.benutzername}` : ''}
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  onclick={() => entfernen(id)}
                  aria-label={m.standplatz_settings_user_remove()}
                >
                  <XIcon class="size-4" />
                </Button>
              </li>
            {/each}
          </ul>
        {/if}
      </div>

      <!-- Wie lange -->
      <div class="border-border/60 flex flex-col gap-2 border-t pt-3">
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
      </div>

      <div class="flex justify-end pt-1">
        <Button
          onclick={freigeben}
          disabled={!jeder && standplatz.nutzer.length === 0}
          data-testid="standplatz-grant"
        >
          {m.standplatz_settings_grant()}
        </Button>
      </div>
    </div>

    <!-- Eintragung als Standplatz-Gerät -->
    <div class="border-border flex flex-col gap-3 rounded-2xl border p-4">
      <span class="text-text-bright flex items-center gap-2 text-sm font-semibold">
        <MonitorCogIcon class="size-4" />
        {m.device_settings_register_title()}
      </span>
      <span class="text-text-muted text-xs">{m.device_settings_register_hint()}</span>

      {#if eintragung}
        <div class="border-border/60 flex items-center gap-2 border-t pt-3">
          <span class="text-text-bright min-w-0 flex-1 truncate font-mono text-sm">
            {eintragung.name}
          </span>
          <Button
            size="sm"
            variant="destructive"
            disabled={eintragBusy}
            onclick={austragen}
            data-testid="device-unregister"
          >
            {m.device_settings_registered_remove()}
          </Button>
        </div>
      {:else}
        <div class="border-border/60 flex flex-col gap-2 border-t pt-3">
          <label class="flex flex-col gap-1">
            <span class="text-text-muted text-xs">{m.device_settings_register_community()}</span>
            <select
              class="border-border bg-bg-input text-text-bright rounded-lg border px-2 py-1.5 text-sm"
              bind:value={zielGuild}
              data-testid="device-register-guild"
            >
              <option value="">—</option>
              {#each guilds.list as g (g.id)}
                <option value={g.id}>{g.name}</option>
              {/each}
            </select>
          </label>
          <label class="flex flex-col gap-1">
            <span class="text-text-muted text-xs">{m.device_settings_register_channel()}</span>
            <select
              class="border-border bg-bg-input text-text-bright rounded-lg border px-2 py-1.5 text-sm"
              bind:value={zielKanal}
              disabled={!zielGuild}
              data-testid="device-register-channel"
            >
              <option value="">—</option>
              {#each sprachkanaele as c (c.id)}
                <option value={c.id}>{c.name}</option>
              {/each}
            </select>
          </label>
          <label class="flex flex-col gap-1">
            <span class="text-text-muted text-xs">{m.device_settings_register_name()}</span>
            <Input bind:value={geraetName} placeholder="werkstatt-pc" data-testid="device-register-name" />
            <span class="text-text-muted text-xs">{m.device_settings_register_name_hint()}</span>
          </label>
          <div class="flex justify-end pt-1">
            <Button
              onclick={eintragen}
              disabled={eintragBusy || !zielGuild || !zielKanal || !geraetName.trim()}
              data-testid="device-register-submit"
            >
              {m.device_settings_register_submit()}
            </Button>
          </div>
        </div>
      {/if}
      {#if eintragFehler}
        <span class="text-xs text-red-500" data-testid="device-register-error">
          {m.device_settings_register_failed()}: {eintragFehler}
        </span>
      {/if}
    </div>

    <!-- Protokoll -->
    <div class="border-border flex flex-col gap-3 rounded-2xl border p-4">
      <span class="text-text-bright flex items-center gap-2 text-sm font-semibold">
        <ScrollTextIcon class="size-4" />
        {m.standplatz_settings_log()}
      </span>
      <span class="text-text-muted text-xs">{m.standplatz_settings_log_hint()}</span>
      {#if remoteProtokoll.eintraege.length === 0}
        <span class="text-text-muted text-xs italic">{m.standplatz_settings_log_empty()}</span>
      {:else}
        <ul class="flex flex-col gap-2" data-testid="standplatz-log">
          {#each remoteProtokoll.eintraege as e (e.id)}
            <li class="border-border/60 flex flex-col gap-0.5 border-b pb-2 last:border-b-0">
              <span class="text-text-bright truncate text-sm">{e.name}</span>
              <span class="text-text-muted text-xs">
                {zeitpunkt(e.beginn)} · {dauer(e.beginn, e.ende)} ·
                {e.selbsttaetig
                  ? m.standplatz_settings_log_auto()
                  : m.standplatz_settings_log_manual()}
              </span>
            </li>
          {/each}
        </ul>
        <div class="flex justify-end">
          <Button size="sm" variant="ghost" onclick={() => remoteProtokoll.leeren()}>
            {m.standplatz_settings_log_clear()}
          </Button>
        </div>
      {/if}
    </div>
  {/if}
</div>
