<!--
  SettingsStandplatzGeraete — „Meine Geräte auf diesem Server".

  Der Grund, warum der Standplatz-Reiter seit 2026-08-20 auch dort sichtbar
  ist, wo dieser RECHNER selbst kein Standplatz sein kann (Linux, macOS,
  Browser — `reiterSichtbar.ts`): jemand kann Geräte BESITZEN, ohne gerade an
  einem von ihnen zu sitzen. Diese Liste ist die Verwaltung dafür — sie fragt
  nicht, ob DIESER Rechner sich anbieten kann, sondern zeigt jedes Gerät,
  dessen Besitzer der angemeldete Nutzer auf DIESEM Server ist.
  Deshalb wird sie unabhängig von `kannStandplatz` gerendert (anders als der
  Rest des Reiters).

  **Läuft über alle geladenen Communitys** (`deviceStore.eigene`), lädt sie
  aber selbst nach: ohne den Effect unten wüsste der Store nur von der
  Community, in der man gerade eine Kanalliste geöffnet hatte.
-->
<script lang="ts">
  import MonitorIcon from '@lucide/svelte/icons/monitor';
  import XIcon from '@lucide/svelte/icons/x';
  import { Button } from '$lib/components/ui/button/index.js';
  import { goto } from '$app/navigation';
  import { deviceStore } from '$lib/devices/store.svelte';
  import { geraeteVerwaltung } from '$lib/devices/verwaltung.svelte';
  import FieldError from '$lib/components/feedback/FieldError.svelte';
  import { punktKlasse, zustandsText, geraetPfad } from '$lib/devices/darstellung';
  import { guilds } from '$lib/stores/guilds.svelte';
  import { currentServerUserId } from '$lib/stores/currentServerUser';
  import { m } from '$lib/paraglide/messages.js';
  import type { Device } from '$lib/api/devices';

  $effect(() => {
    for (const g of guilds.list) {
      void deviceStore.ensureLoaded(g.id);
      void guilds.ensureChannels(g.id);
    }
  });

  const eigeneGeraete = $derived(deviceStore.eigene(currentServerUserId()));

  function communityName(device: Device): string {
    return guilds.byId[device.guild_id]?.name ?? device.guild_id;
  }

  function standplatzName(device: Device): string {
    return (
      (guilds.channelsByGuild[device.guild_id] ?? []).find((c) => c.id === device.channel_id)
        ?.name ?? device.channel_id
    );
  }

  function oeffnen(device: Device): void {
    void goto(geraetPfad(device));
  }
</script>

<div class="border-border flex flex-col gap-3 rounded-2xl border p-4" data-testid="settings-my-devices">
  <span class="text-text-bright flex items-center gap-2 text-sm font-semibold">
    <MonitorIcon class="size-4" />
    {m.device_settings_my_devices_title()}
  </span>

  {#if eigeneGeraete.length === 0}
    <span class="text-text-muted text-xs italic">{m.device_settings_my_devices_empty()}</span>
  {:else}
    <ul class="flex flex-col gap-1.5">
      {#each eigeneGeraete as d (d.id)}
        <li class="border-border/60 flex items-center gap-2 rounded-lg border px-2.5 py-1.5">
          <button
            type="button"
            class="flex min-w-0 flex-1 flex-col items-start text-left"
            onclick={() => oeffnen(d)}
            title={m.device_settings_my_devices_open()}
            data-testid={`my-device-open-${d.id}`}
          >
            <span class="text-text-bright truncate text-sm hover:underline">{d.name}</span>
            <span class="text-text-muted flex min-w-0 items-center gap-1.5 truncate text-xs">
              <span class="size-2 shrink-0 rounded-full {punktKlasse(d.state)}" aria-hidden="true"
              ></span>
              {m.device_settings_my_devices_meta({
                guild: communityName(d),
                channel: standplatzName(d),
                state: zustandsText(d.state),
              })}
            </span>
          </button>
          <Button
            variant="ghost"
            size="icon"
            class="size-6 shrink-0"
            disabled={geraeteVerwaltung.laeuft}
            onclick={() => geraeteVerwaltung.entfernen(d.guild_id, d.id)}
            data-testid={`my-device-remove-${d.id}`}
            aria-label={m.device_manage_remove()}
          >
            <XIcon class="size-3.5" />
          </Button>
        </li>
      {/each}
    </ul>
  {/if}

  <FieldError
    message={geraeteVerwaltung.fehler === null
      ? null
      : m.device_manage_error({ error: geraeteVerwaltung.fehler })}
    testId="settings-my-devices-error"
  />
</div>
