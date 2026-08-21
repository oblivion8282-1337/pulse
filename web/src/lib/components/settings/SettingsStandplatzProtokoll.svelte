<!--
  SettingsStandplatzProtokoll — das Protokoll vergangener Übernahmen.

  Ausgelagert aus `SettingsStandplatz.svelte` (Zerlegung Aufgabe 10, Grenze
  250 Zeilen für Svelte-Komponenten). Reine Anzeige von `remoteProtokoll` +
  „Protokoll leeren" — die Begründung, warum das Protokoll überhaupt neben der
  Freigabe steht (§7 des Entwurfs), steht am Dateikopf von `SettingsStandplatz`.
-->
<script lang="ts">
  import ScrollTextIcon from '@lucide/svelte/icons/scroll-text';
  import { Button } from '$lib/components/ui/button/index.js';
  import { remoteProtokoll } from '$lib/remote/protokoll.svelte';
  import { m } from '$lib/paraglide/messages.js';

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
</script>

<div class="border-border flex flex-col gap-3 rounded-2xl border p-4">
  <span class="text-text-bright flex items-center gap-2 text-sm font-semibold">
    <ScrollTextIcon class="size-4" />
    {m.standplatz_settings_log()}
  </span>
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
