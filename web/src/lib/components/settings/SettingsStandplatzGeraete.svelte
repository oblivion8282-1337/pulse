<!--
  SettingsStandplatzGeraete — „Meine Remote-Rechner".

  Der Grund, warum der Reiter auch dort sichtbar ist, wo dieser RECHNER selbst
  kein Standplatz sein kann (Linux, macOS, Browser — `reiterSichtbar.ts`):
  jemand kann Geräte BESITZEN, ohne gerade an einem von ihnen zu sitzen. Diese
  Liste zeigt jedes Gerät, dessen Besitzer der angemeldete Nutzer auf DIESEM
  Server ist, und wird deshalb unabhängig von `kannStandplatz` gerendert.

  **Nur Liste, keine Verwaltung** (seit 2026-09-09): der Lösch-Knopf je
  Zeile ist weg. Auf einem eingetragenen Rechner stand sein eigenes Gerät
  sonst zweimal im Reiter, mit zwei Lösch-Knöpfen. Jede Zeile führt in die
  Geräteansicht, und dort gibt es Umbenennen, Umziehen und Entfernen einmal
  und vollständig. Der eigene Rechner ist markiert statt doppelt aufgeführt.

  **Läuft über alle geladenen Communitys** (`deviceStore.eigene`), lädt sie
  aber selbst nach: ohne den Effect unten wüsste der Store nur von der
  Community, in der man gerade eine Kanalliste geöffnet hatte.
-->
<script lang="ts">
  import ChevronRightIcon from '@lucide/svelte/icons/chevron-right';
  import { goto } from '$app/navigation';
  import { deviceStore } from '$lib/devices/store.svelte';
  import { geraeteAnmeldung } from '$lib/devices/anmeldung.svelte';
  import { punktKlasse, geraetPfad } from '$lib/devices/darstellung';
  import { geraetOrtText } from '$lib/devices/ort';
  import { guilds } from '$lib/stores/guilds.svelte';
  import { activeServer } from '$lib/stores/active-server.svelte';
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
  const diesesGeraetId = $derived(geraeteAnmeldung.fuerServer(activeServer.serverId)?.deviceId ?? null);

  function oeffnen(device: Device): void {
    void goto(geraetPfad(device));
  }
</script>

<div class="flex flex-col gap-2" data-testid="settings-my-devices">
  {#if eigeneGeraete.length === 0}
    <span class="border-border text-text-muted rounded-2xl border border-dashed p-4 text-xs">
      {m.device_settings_my_devices_empty()}
    </span>
  {:else}
    <ul class="border-border flex flex-col gap-1 rounded-2xl border p-2">
      {#each eigeneGeraete as d (d.id)}
        <li>
          <button
            type="button"
            class="hover:bg-bg-hover flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left transition-colors"
            onclick={() => oeffnen(d)}
            title={m.device_settings_my_devices_open()}
            data-testid={`my-device-open-${d.id}`}
          >
            <span class="flex min-w-0 flex-1 flex-col">
              <span class="text-text-bright flex items-center gap-2 truncate text-sm">
                {d.name}
                {#if d.id === diesesGeraetId}
                  <span class="border-border text-text-muted rounded-md border px-1.5 text-2xs" data-testid="my-device-this">
                    {m.device_settings_my_devices_this()}
                  </span>
                {/if}
              </span>
              <span class="text-text-muted flex min-w-0 items-center gap-1.5 truncate text-xs">
                <span class="size-2 shrink-0 rounded-full {punktKlasse(d.state)}" aria-hidden="true"></span>
                {geraetOrtText(d)}
              </span>
            </span>
            <ChevronRightIcon class="text-text-muted size-4 shrink-0" />
          </button>
        </li>
      {/each}
    </ul>
  {/if}
  <span class="text-text-muted text-xs">{m.device_settings_my_devices_hint()}</span>
</div>
