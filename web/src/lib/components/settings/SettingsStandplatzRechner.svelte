<!--
  SettingsStandplatzRechner — die eine Karte für DIESEN Rechner: wo er
  eingetragen ist, ob er sich steuern lässt, und wer das ohne Rückfrage darf.

  **Warum eine Karte statt vier** (Umbau 2026-09-09): vorher standen Zustand,
  „Wie lange", die Verwaltung (Name, Community, Kanal) und die Freigabeliste
  als getrennte Kästen untereinander — und die Verwaltung gab es wortgleich
  noch einmal in der Geräteansicht im Kanal, auf die die Liste „Meine Geräte"
  ohnehin verlinkt. Hier bleibt, was nur diesen Rechner betrifft und nirgends
  sonst steht: der Schalter und die Personen. Umbenennen, Umziehen und
  Entfernen gehen über den Link in der Kopfzeile.

  **Der Schalter ist nur noch An/Aus.** Der Ablauf hängt allein an den
  Freigabe-Zeilen (`DeviceFreigaben`) — zwei Abläufe untereinander, einer für
  den Schalter und einer je Person, liessen offen, welcher gewinnt. Ein alter
  Speicherstand mit befristetem Schalter läuft weiter ab und zeigt sein Ende
  unter dem Schalter an; neu gesetzt wird er dauerhaft.
-->
<script lang="ts">
  import MonitorCogIcon from '@lucide/svelte/icons/monitor-cog';
  import ChevronDownIcon from '@lucide/svelte/icons/chevron-down';
  import Switch from '$lib/components/form/Switch.svelte';
  import DeviceFreigaben from '$lib/devices/components/DeviceFreigaben.svelte';
  import DeviceVerwaltung from '$lib/devices/components/DeviceVerwaltung.svelte';
  import { standplatz } from '$lib/remote/standplatz.svelte';
  import { restzeit } from '$lib/devices/restzeit';
  import { restText } from '$lib/devices/restanzeige';
  import { geraetOrtText } from '$lib/devices/ort';
  import { punktKlasse } from '$lib/devices/darstellung';
  import { formatTimestamp } from '$lib/utils/formatTimestamp';
  import { m } from '$lib/paraglide/messages.js';
  import type { Device } from '$lib/api/devices';

  let { device }: { device: Device } = $props();

  // Halbminütlich, nicht sekündlich: Chromium drosselt Zeitgeber in verdeckten
  // Fenstern — die übliche Lage eines Standplatz-Rechners. Die Anzeige nennt
  // deshalb das Ende (das wird nie falsch) und dazu eine grobe Restzeit.
  let jetzt = $state(Date.now());
  $effect(() => {
    const t = setInterval(() => (jetzt = Date.now()), 30_000);
    return () => clearInterval(t);
  });

  const ablaufText = $derived.by(() => {
    const bis = standplatz.gueltigBis;
    if (!standplatz.aktiv || bis === null) return null;
    const rest = restzeit(new Date(bis).toISOString(), jetzt);
    const restSatz =
      rest === null || rest === 'abgelaufen' ? m.standplatz_rest_minutes({ count: 1 }) : restText(rest);
    return `${m.standplatz_until({ zeitpunkt: formatTimestamp(new Date(bis).toISOString()) })} · ${restSatz}`;
  });

  function umlegen(an: boolean): void {
    if (an) void standplatz.freigeben({ geltung: 'dauerhaft' });
    else void standplatz.zuruecknehmen();
  }

  // Die Eintragung (Name, Community, Kanal, Entfernen) klappt HIER im Panel
  // auf statt in die Geräteansicht zu navigieren — Remote-UI-Runde
  // 2026-09-09: das Panel ist der Ort für diesen Rechner, ein Klick darf die
  // Ansicht nicht verlassen.
  let eintragungOffen = $state(false);
</script>

<div class="border-border flex flex-col gap-4 rounded-2xl border p-4" data-testid="standplatz-rechner">
  <div class="flex items-center gap-3">
    <span class="bg-bg-input grid size-9 shrink-0 place-items-center rounded-lg">
      <MonitorCogIcon class={standplatz.aktiv ? 'size-5 text-emerald-500' : 'text-text-muted size-5'} />
    </span>
    <span class="flex min-w-0 flex-1 flex-col">
      <span class="text-text-bright truncate text-sm font-semibold">{device.name}</span>
      <span class="text-text-muted flex items-center gap-1.5 truncate text-xs">
        <span class="size-2 shrink-0 rounded-full {punktKlasse(device.state)}" aria-hidden="true"></span>
        {geraetOrtText(device)}
      </span>
    </span>
    <button
      type="button"
      class="text-accent-on-soft flex shrink-0 items-center gap-1 text-xs hover:underline"
      onclick={() => (eintragungOffen = !eintragungOffen)}
      aria-expanded={eintragungOffen}
      data-testid="standplatz-rechner-eintragung"
    >
      {m.standplatz_rechner_eintragung_aendern()}
      <ChevronDownIcon
        class="size-3.5 transition-transform {eintragungOffen ? 'rotate-180' : ''}"
      />
    </button>
  </div>

  {#if eintragungOffen}
    <div class="border-border/60 border-t pt-4" data-testid="standplatz-eintragung-verwaltung">
      <DeviceVerwaltung {device} />
    </div>
  {/if}

  <div class="border-border/60 flex items-center justify-between gap-3 border-t pt-4">
    <span class="flex min-w-0 flex-col">
      <span class="text-text-bright text-sm font-medium">{m.standplatz_rechner_erlauben()}</span>
      {#if ablaufText}
        <span class="text-text-muted text-xs">{ablaufText}</span>
      {/if}
    </span>
    <Switch
      checked={standplatz.aktiv}
      onCheckedChange={umlegen}
      aria-label={m.standplatz_rechner_erlauben()}
      data-testid="standplatz-schalter"
    />
  </div>

  <div class="border-border/60 border-t pt-4">
    <DeviceFreigaben {device} eingebettet />
  </div>
</div>
