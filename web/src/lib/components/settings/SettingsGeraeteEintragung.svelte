<!--
  SettingsGeraeteEintragung — diesen Rechner als Standplatz-Gerät eintragen.

  Das Gegenstück zur Dauerfreigabe nebenan: die gibt den Rechner **frei**, das
  hier gibt ihm einen **Ort**. Beides steht im selben Reiter, weil nur beides
  zusammen einen Standplatz ergibt — freigegeben und nirgends auffindbar ist so
  nutzlos wie eingetragen und für niemanden freigegeben.

  Eigene Datei wegen der Grössen-Regel (Komponenten ≤250 Zeilen): der Reiter
  trägt drei getrennte Themen (Freigabe, Protokoll, Eintragung), und an dieser
  Naht teilt er sich von selbst.
-->
<script lang="ts">
  import MonitorCogIcon from '@lucide/svelte/icons/monitor-cog';
  import { Button } from '$lib/components/ui/button/index.js';
  import { Input } from '$lib/components/ui/input/index.js';
  import { devicesApi } from '$lib/api/devices';
  import { ApiError } from '$lib/api/client';
  import { deviceStore } from '$lib/devices/store.svelte';
  import { geraeteAnmeldung } from '$lib/devices/anmeldung.svelte';
  import { guilds } from '$lib/stores/guilds.svelte';
  import { activeServer } from '$lib/stores/active-server.svelte';
  import { gatewayForServer } from '$lib/ws/connection';
  import { m } from '$lib/paraglide/messages.js';

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
      //
      // Über `anmelden()` und NICHT direkt über den Sender (Bughunt
      // 2026-08-16): der Sender lässt die Bildschirmliste sonst leer, und eine
      // leere Liste übernimmt der Server bewusst nicht. Der Rechner stand
      // damit bis zum nächsten Verbindungsaufbau — bei einem Standplatz-Gerät
      // womöglich tagelang — mit einem einzigen „Hauptbildschirm" da, und wer
      // gleich nach dem Einrichten prüfte, hielt die Mehrschirm-Funktion für
      // nicht vorhanden.
      const conn = gatewayForServer(serverId);
      if (conn) {
        await geraeteAnmeldung.anmelden(
          (deviceId, monitore) => conn.sendDeviceAnnounce(deviceId, monitore),
          { serverId, guildId: device.guild_id, deviceId: device.id, name: device.name },
        );
      }
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
      // **404 heisst fertig, nicht gescheitert** (Bughunt 2026-08-16): die Zeile
      // ist auf dem Server nicht mehr da — ein anderer Rechner desselben Kontos
      // oder ein Admin war schneller. Bis hierher blieb die lokale Eintragung
      // in genau diesem Fall stehen, und der Rechner meldete sich fortan bei
      // JEDEM Verbindungsaufbau als ein Gerät an, das es nicht gibt; der Server
      // verwarf das still. Sichtbar war davon nur, dass „Eintragung entfernen"
      // nichts bewirkt hat.
      if (err instanceof ApiError && err.status === 404) {
        await geraeteAnmeldung.vergessen(e.deviceId);
      } else {
        eintragFehler = err instanceof Error ? err.message : String(err);
      }
    } finally {
      eintragBusy = false;
    }
  }
</script>

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
