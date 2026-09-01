<!--
  SettingsGeraeteEintragungNeu — das Formular, mit dem dieser Rechner zum
  Standplatz-Gerät wird: Community, Sprachkanal, Name.

  Eigene Datei neben `SettingsGeraeteEintragung` (Grössen-Regel, Komponenten
  ≤250 Zeilen). Die Naht ist die Lage: dort die Frage, in welchem der vier
  Zustände dieser Rechner ist, hier der eine Zustand „noch nicht eingetragen".

  **Die drei Leer-Hinweise sind der eigentliche Inhalt** (Bughunt 2026-08-21).
  Ein Auswahlfeld ohne Einträge ist von einem kaputten nicht zu unterscheiden,
  und beide Felder hier können vollkommen berechtigt leer sein: ohne Community
  gibt es keinen Standplatz, und eine Community ohne Sprachkanal, in dem man
  übertragen darf, trägt keinen. Ohne den Satz daneben sucht man den Fehler in
  der Anwendung statt in den Rechten.
-->
<script lang="ts">
import { errText } from '$lib/utils/errText';
  import MonitorCogIcon from '@lucide/svelte/icons/monitor-cog';
  import { Button } from '$lib/components/ui/button/index.js';
  import { Input } from '$lib/components/ui/input/index.js';
  import Select from '$lib/components/form/Select.svelte';
  import { devicesApi } from '$lib/api/devices';
  import { deviceStore } from '$lib/devices/store.svelte';
  import { geraeteAnmeldung } from '$lib/devices/anmeldung.svelte';
  import { guilds } from '$lib/stores/guilds.svelte';
  import { gatewayForServer } from '$lib/ws/connection';
  import { m } from '$lib/paraglide/messages.js';

  let { serverId }: { serverId: string | null } = $props();

  let zielGuild = $state('');
  let zielKanal = $state('');
  let geraetName = $state('');
  let busy = $state(false);
  let fehler = $state<string | null>(null);

  const sprachkanaele = $derived(
    (guilds.channelsByGuild[zielGuild] ?? []).filter((c) => c.type === 1),
  );
  // Die Kanäle der gewählten Community nachladen. `channelsByGuild` ist nur
  // für Communitys gefüllt, deren Kanalliste schon einmal geöffnet oder
  // anderswo vorgeladen wurde — ohne das bliebe das Feld darunter grundlos
  // leer (dieselbe Stelle wie in `DeviceVerwaltung`).
  $effect(() => {
    if (zielGuild) void guilds.ensureChannels(zielGuild).catch(() => undefined);
  });

  const guildOptionen = $derived(guilds.list.map((g) => ({ value: g.id, label: g.name })));
  const kanalOptionen = $derived(sprachkanaele.map((c) => ({ value: c.id, label: c.name })));

  async function eintragen(): Promise<void> {
    if (!serverId || !zielGuild || !zielKanal || !geraetName.trim()) return;
    busy = true;
    fehler = null;
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
      fehler = errText(e);
    } finally {
      busy = false;
    }
  }
</script>

<div class="border-border flex flex-col gap-3 rounded-2xl border p-4">
  <span class="text-text-bright flex items-center gap-2 text-sm font-semibold">
    <MonitorCogIcon class="size-4" />
    {m.device_settings_register_title()}
  </span>

  <div class="border-border/60 flex flex-col gap-2 border-t pt-3">
    <label class="flex flex-col gap-1">
      <span class="text-text-muted text-xs">{m.device_settings_register_community()}</span>
      <Select
        value={zielGuild}
        options={guildOptionen}
        placeholder="—"
        onchange={(v) => {
          zielGuild = v;
          // Der Kanal gehört zur alten Community, bis die neue etwas anderes
          // sagt (Muster aus `DeviceVerwaltung`).
          zielKanal = '';
        }}
        data-testid="device-register-guild"
      />
      {#if guildOptionen.length === 0}
        <span class="text-text-muted text-xs">{m.device_settings_register_no_guilds()}</span>
      {/if}
    </label>

    <label class="flex flex-col gap-1">
      <span class="text-text-muted text-xs">{m.device_settings_register_channel()}</span>
      <Select
        value={zielKanal}
        options={kanalOptionen}
        placeholder="—"
        disabled={!zielGuild}
        onchange={(v) => (zielKanal = v)}
        data-testid="device-register-channel"
      />
      {#if zielGuild && kanalOptionen.length === 0}
        <span class="text-text-muted text-xs">{m.device_settings_register_no_channels()}</span>
      {/if}
    </label>

    <label class="flex flex-col gap-1">
      <span class="text-text-muted text-xs">{m.device_settings_register_name()}</span>
      <Input bind:value={geraetName} placeholder="werkstatt-pc" data-testid="device-register-name" />
      <span class="text-text-muted text-xs">{m.device_settings_register_name_hint()}</span>
    </label>

    <div class="flex justify-end pt-1">
      <Button
        onclick={eintragen}
        disabled={busy || !zielGuild || !zielKanal || !geraetName.trim()}
        data-testid="device-register-submit"
      >
        {m.device_settings_register_submit()}
      </Button>
    </div>
  </div>

  {#if fehler}
    <span class="text-xs text-red-500" data-testid="device-register-error">
      {m.device_settings_register_failed()}: {fehler}
    </span>
  {/if}
</div>
