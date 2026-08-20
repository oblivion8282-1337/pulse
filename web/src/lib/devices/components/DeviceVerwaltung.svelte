<!--
  DeviceVerwaltung — ein Gerät von JEDEM Rechner aus verwalten, nicht nur von
  ihm selbst.

  Umbenennen und Entfernen darf der Besitzer ODER wer `MANAGE_GUILD` hat.
  Umstellen (Kanal und Community) darf NUR der Besitzer — der Standplatz ist
  der Rechteanker, und wer ihn setzt, bestimmt, wer den Rechner übernehmen
  darf. Ein Verwalter ohne Besitzrecht bekommt die beiden Felder deshalb gar
  nicht erst angeboten.

  `$state` mit Nachführung statt `bind:value` direkt auf die Gerätezeile: die
  kommt über `device_changed` von der WebSocket herein und würde eine gerade
  getroffene Eingabe überschreiben (Muster wie in `SettingsGeraeteEintragung`).
-->
<script lang="ts">
  import { Button } from '$lib/components/ui/button/index.js';
  import { Input } from '$lib/components/ui/input/index.js';
  import { geraeteVerwaltung } from '$lib/devices/verwaltung.svelte';
  import { guilds } from '$lib/stores/guilds.svelte';
  import { currentServerUserId } from '$lib/stores/currentServerUser';
  import { m } from '$lib/paraglide/messages.js';
  import type { Device } from '$lib/api/devices';

  let { device, darfVerwalten }: { device: Device; darfVerwalten: boolean } = $props();

  const istBesitzer = $derived(device.owner_user_id === currentServerUserId());

  let name = $state('');
  $effect(() => {
    if (!name) name = device.name;
  });

  let zielGuild = $state('');
  $effect(() => {
    if (!zielGuild) zielGuild = device.guild_id;
  });

  let zielKanal = $state('');
  // **Am Geräte-Identität hängen, nicht an „ist gerade leer"** (Fix zu
  // Prüfbefund G-1, 2026-08-20): das gewöhnliche Nachführ-Muster (`if
  // (!zielKanal) …`) las `zielKanal`, wurde also von JEDER Änderung
  // erneut ausgelöst — auch von `umstellenGuild()`s absichtlichem Leeren,
  // das dieselbe Anweisung im selben Durchlauf rückgängig machte. Wer nur
  // `device.id` liest, füllt ausschliesslich beim Wechsel auf ein ANDERES
  // Gerät neu — ein bewusstes Leeren nach Community-Wechsel bleibt leer und
  // zwingt zur echten Auswahl aus `sprachkanaele`.
  let zielKanalGeraet = '';
  $effect(() => {
    if (zielKanalGeraet !== device.id) {
      zielKanalGeraet = device.id;
      zielKanal = device.channel_id;
    }
  });

  const sprachkanaele = $derived(
    (guilds.channelsByGuild[zielGuild] ?? []).filter((c) => c.type === 1),
  );

  function umbenennen(): void {
    const wert = name.trim();
    if (!wert || wert === device.name) return;
    void geraeteVerwaltung.umbenennen(device.guild_id, device.id, wert);
  }

  function umstellenGuild(): void {
    // Der Kanal gehört zur alten Community, bis die neue etwas anderes sagt —
    // ein Wechsel der Community allein ohne passenden Kanal wäre eine Anfrage,
    // die der Server ohnehin ablehnt (Zielkanal muss zur Zielcommunity gehören).
    zielKanal = '';
  }

  function umstellen(): void {
    if (!zielGuild || !zielKanal) return;
    if (zielGuild === device.guild_id && zielKanal === device.channel_id) return;
    void geraeteVerwaltung.umstellen(device.guild_id, device.id, zielGuild, zielKanal);
  }

  function entfernen(): void {
    void geraeteVerwaltung.entfernen(device.guild_id, device.id);
  }
</script>

<div class="border-border flex w-full max-w-sm flex-col gap-3 rounded-2xl border p-4 text-left">
  <span class="text-text-bright text-sm font-semibold">{m.device_manage_title()}</span>

  <label class="flex flex-col gap-1">
    <span class="text-text-muted text-xs">{m.device_manage_name_label()}</span>
    <Input
      bind:value={name}
      disabled={geraeteVerwaltung.laeuft}
      onblur={umbenennen}
      data-testid="device-manage-name"
    />
  </label>

  {#if istBesitzer}
    <label class="flex flex-col gap-1">
      <span class="text-text-muted text-xs">{m.device_manage_guild_label()}</span>
      <select
        class="border-border bg-bg-input text-text-bright rounded-lg border px-2 py-1.5 text-sm"
        bind:value={zielGuild}
        disabled={geraeteVerwaltung.laeuft}
        onchange={umstellenGuild}
        data-testid="device-manage-guild"
      >
        {#each guilds.list as g (g.id)}
          <option value={g.id}>{g.name}</option>
        {/each}
      </select>
    </label>
    <label class="flex flex-col gap-1">
      <span class="text-text-muted text-xs">{m.device_manage_channel_label()}</span>
      <select
        class="border-border bg-bg-input text-text-bright rounded-lg border px-2 py-1.5 text-sm"
        bind:value={zielKanal}
        disabled={geraeteVerwaltung.laeuft || sprachkanaele.length === 0}
        onchange={umstellen}
        data-testid="device-manage-channel"
      >
        <option value="">—</option>
        {#each sprachkanaele as c (c.id)}
          <option value={c.id}>{c.name}</option>
        {/each}
      </select>
    </label>
    {#if geraeteVerwaltung.geraeumteRollen > 0}
      <p class="text-text-muted text-xs" data-testid="device-manage-role-grants-cleared">
        {m.device_manage_role_grants_cleared({ count: geraeteVerwaltung.geraeumteRollen })}
      </p>
    {/if}
  {/if}

  {#if istBesitzer || darfVerwalten}
    <Button
      size="sm"
      variant="destructive"
      disabled={geraeteVerwaltung.laeuft}
      onclick={entfernen}
      data-testid="device-manage-remove"
    >
      {m.device_manage_remove()}
    </Button>
  {/if}

  {#if geraeteVerwaltung.fehler}
    <p class="text-xs text-red-500" data-testid="device-manage-error">
      {m.device_manage_error({ error: geraeteVerwaltung.fehler })}
    </p>
  {/if}
</div>
