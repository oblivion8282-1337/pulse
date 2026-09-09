<!--
  Einstieg „Remote-Rechner" in der GuildRail — testweise aus dem
  Einstellungsdialog hierher verlagert (2026-09-09): der Klick öffnet ein
  Panel NUR mit dem Standplatz-Inhalt (`SettingsStandplatz`), statt eines
  Reiters unter allen Einstellungen.

  Sichtbar nach derselben Regel, mit der früher der Reiter erschien
  (`reiterSichtbar`): Dieser Rechner kann selbst Standplatz sein, oder es
  liegt eine Eintragung vor, oder der Nutzer besitzt Geräte auf diesem
  Server. Die drei Gründe und ihre Geschichte standen an der Reiter-Regel in
  `settings/reiterAuswahl.svelte.ts` — sie sind mit dem Reiter hierher
  gewandert.

  Die Rail ist `hidden lg:flex` — mobil hat der Einstieg (noch) keinen Ort;
  der frühere Reiter zeigte sich dort im Du-Bereich.
-->
<script lang="ts">
  import { Popover } from 'bits-ui';
  import { page } from '$app/state';
  import MonitorCogIcon from '@lucide/svelte/icons/monitor-cog';
  import SettingsStandplatz from '$lib/components/settings/SettingsStandplatz.svelte';
  import { alleGeraeteVorladen } from '$lib/components/settings/reiterAuswahl.svelte';
  import { activeServer } from '$lib/stores/active-server.svelte';
  import { currentServerUserId } from '$lib/stores/currentServerUser';
  import { deviceStore } from '$lib/devices/store.svelte';
  import { geraeteAnmeldung } from '$lib/devices/anmeldung.svelte';
  import { geraeteVerwaltung } from '$lib/devices/verwaltung.svelte';
  import { geraetNameNormalisieren } from '$lib/devices/geraetName';
  import { rechnerName } from '$lib/devices/rechnerName.svelte';
  import { darfStandplatzSein } from '$lib/remote/darfStandplatzSein';
  import { reiterSichtbar } from '$lib/devices/reiterSichtbar';
  import { m } from '$lib/paraglide/messages.js';

  // Geräte aller Communitys vorladen — ohne das kennt `deviceStore.eigene()`
  // nur die Community, deren Kanalliste zuletzt offen war, und die
  // Sichtbarkeit bliebe falsch, wenn das eigene Gerät woanders steht
  // (Henne-Ei-Fall, s. `alleGeraeteVorladen`).
  $effect(() => {
    alleGeraeteVorladen();
  });

  const sichtbar = $derived(
    reiterSichtbar({
      kannStandplatzSein: darfStandplatzSein(),
      hatEintragung: !!geraeteAnmeldung.fuerServer(activeServer.serverId),
      besitztGeraete: deviceStore.eigene(currentServerUserId()).length > 0,
    }),
  );

  // Der Name DIESES Rechners als erstes Feld des Panels. Eingetragen geht er
  // an die Server-Zeile, sonst nur in den lokalen Rechner-Speicher — der Name
  // ist damit schon gespeichert, BEVOR irgendwo eingetragen wird.
  const eintragung = $derived(geraeteAnmeldung.fuerServer(activeServer.serverId));
  const geraet = $derived(
    eintragung ? deviceStore.byId(eintragung.guildId, eintragung.deviceId) : null,
  );

  let name = $state<string | null>(null);
  $effect(() => {
    name = geraet ? geraet.name : rechnerName.name;
  });

  async function nameSpeichern(): Promise<void> {
    if (name === null) return;
    const neu = name.trim();
    if (!neu) return;
    if (geraet && neu !== geraet.name) {
      await geraeteVerwaltung.umbenennen(geraet.guild_id, geraet.id, neu);
    }
    // Immer auch lokal — ohne Eintragung ist das der EINZIGE Ort, mit
    // Eintragung bleibt der Name erhalten, falls die Zeile mal weg fällt.
    await rechnerName.speichern(neu);
  }

  // Kontrolliert offen, damit eine Navigation das Panel wieder zumacht —
  // sonst deckt es die Ansicht zu, zu der eine Zeile aus „Meine
  // Remote-Rechner" gerade navigiert ist.
  let offen = $state(false);
  $effect(() => {
    void page.url;
    offen = false;
  });
</script>

{#if sichtbar}
  <Popover.Root bind:open={offen}>
    <Popover.Trigger>
      {#snippet child({ props })}
        <button
          {...props}
          class="text-text-muted hover:bg-bg-hover hover:text-primary flex size-12 items-center justify-center rounded-xl transition-all hover:rounded-md md:size-10"
          data-testid="open-standplatz"
          aria-label={m.settings_dialog_tab_standplatz()}
        >
          <MonitorCogIcon class="size-6 md:size-5" />
        </button>
      {/snippet}
    </Popover.Trigger>
    <Popover.Portal>
      <Popover.Content
        side="right"
        sideOffset={8}
        collisionPadding={16}
        class="standplatz-panel ring-border z-50 max-h-[min(52rem,92dvh)] w-[32rem] overflow-y-auto rounded-xl p-5 shadow-xl ring-1 outline-none"
        data-testid="standplatz-panel"
      >
        <span class="text-text-muted mb-4 block text-xs font-semibold tracking-wide uppercase">
          {m.settings_dialog_tab_standplatz()}
        </span>
        {#if name !== null}
          <label class="mb-4 block" data-testid="standplatz-name-feld">
            <span class="text-text-muted mb-1 block text-xs font-semibold tracking-wide uppercase">
              {m.device_settings_register_name()}
            </span>
            <!-- Bewusst ein NATIVES input statt der ui-Input-Komponente: die
                 wrapper via bind:value + Props-Streuung hat die change-Events
                 nicht ans Element durchgereicht (Befund 2026-09-09, das
                 Speichern tat einfach nichts). -->
            <input
              class="border-input focus-visible:border-ring focus-visible:ring-ring/50 h-9 w-full rounded-xl border bg-card px-3 text-sm shadow-xs transition-[color,box-shadow] outline-none focus-visible:ring-3"
              value={name}
              oninput={(e) => (name = geraetNameNormalisieren(e.currentTarget.value))}
              onchange={nameSpeichern}
              onkeydown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
              data-testid="standplatz-name"
            />
            <span class="text-text-muted mt-1 block text-xs">
              {m.device_settings_register_name_hint()}
            </span>
          </label>
        {/if}
        <SettingsStandplatz />
      </Popover.Content>
    </Popover.Portal>
  </Popover.Root>
{/if}

<style>
  /* Absichtlich opak: die Panel-/Popover-Token der App (--panel-solid,
     --popover) sind leicht durchscheinend (Glas) — bei einem kleinen Menü
     okay, bei einem Inhalts-Panel dieser Größe unangenehm zu lesen. Dark
     ist #18181c: dieselbe blaugestischte Grau-Familie wie --popover
     (#18181b), nur ohne Alpha — die Felder drauf (bg-card, bg-bg-input,
     helle Transparenzschichten) heben sich dadurch wieder ab, wie im
     Einstellungsdialog. */
  :global(.standplatz-panel) {
    background: #ffffff;
  }
  :global(.dark .standplatz-panel) {
    background: #18181c;
  }
  /* Karten heben sich eine Stufe von der Grundfläche ab — dasselbe Muster wie
     überall sonst (helle Transparenzschicht auf dunkler Fläche). Alle Karten
     dieser Oberfläche sind `rounded-2xl border`, deshalb greift der Selektor
     an genau den Boxen, die es betreffen darf; Felder (rounded-xl, bg-card)
     liegen eine Stufe darüber. */
  :global(.dark .standplatz-panel .rounded-2xl.border) {
    background: rgba(255, 255, 255, 0.03);
  }
</style>
