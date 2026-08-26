<!--
  DeviceVerwaltung — ein Gerät von JEDEM Rechner aus verwalten, nicht nur von
  ihm selbst.

  **Alles hier darf nur der Besitzer** — Umbenennen, Umstellen, Entfernen. Der
  Rechner gehört nicht der Community, er steht nur darin; wer ihn zur Verfügung
  stellt, entscheidet allein über ihn. Wer nicht Besitzer ist, bekommt kein
  einziges Feld angeboten, und der Gateway lehnt es zusätzlich ab
  (`routes/devices.py::_require_owner`).

  Bis zum 2026-08-26 durfte `MANAGE_GUILD` umbenennen und entfernen; das
  Namensfeld war sogar **völlig ungegatet** und stand jedem Betrachter offen —
  die Route liess es durch, solange er `MANAGE_GUILD` hatte. Was der Verwaltung
  bleibt, betrifft ihren Raum: übernehmen nach den Kanalrechten und eine
  laufende Sitzung beenden.

  `$state` mit Nachführung statt `bind:value` direkt auf die Gerätezeile: die
  kommt über `device_changed` von der WebSocket herein und würde eine gerade
  getroffene Eingabe überschreiben (Muster wie in `SettingsGeraeteEintragung`).
-->
<script lang="ts">
  import { Button } from '$lib/components/ui/button/index.js';
  import { Input } from '$lib/components/ui/input/index.js';
  import Select from '$lib/components/form/Select.svelte';
  import { geraeteVerwaltung } from '$lib/devices/verwaltung.svelte';
  import { guilds } from '$lib/stores/guilds.svelte';
  import { currentServerUserId } from '$lib/stores/currentServerUser';
  import { m } from '$lib/paraglide/messages.js';
  import type { Device } from '$lib/api/devices';

  // Kein `darfVerwalten` mehr: es steuerte nur noch den Entfernen-Knopf, und
  // seit der Besitzer allein entscheidet, gibt es nichts, was ein Verwalter
  // hier dürfte. Ein Merker, der immer dasselbe bedeutet, ist einer zu viel.
  let { device }: { device: Device } = $props();

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
  // **Die Kanäle der GEWÄHLTEN Community nachladen** (Bughunt 2026-08-21).
  // `channelsByGuild` ist nur für Communitys gefüllt, deren Kanalliste schon
  // einmal geöffnet oder anderswo vorgeladen wurde. Ohne das hier bot der
  // Community-Wechsel oben eine Auswahl an, deren Kanalfeld darunter leer und
  // ausgegraut blieb — ein Wechsel, den die Oberfläche anbietet und dann nicht
  // zu Ende gehen lässt.
  $effect(() => {
    if (zielGuild) void guilds.ensureChannels(zielGuild).catch(() => undefined);
  });

  const guildOptionen = $derived(guilds.list.map((g) => ({ value: g.id, label: g.name })));
  const kanalOptionen = $derived(sprachkanaele.map((c) => ({ value: c.id, label: c.name })));

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

  {#if istBesitzer}
    <label class="flex flex-col gap-1">
      <span class="text-text-muted text-xs">{m.device_manage_name_label()}</span>
      <Input
        bind:value={name}
        disabled={geraeteVerwaltung.laeuft}
        onblur={umbenennen}
        data-testid="device-manage-name"
      />
    </label>
    <label class="flex flex-col gap-1">
      <span class="text-text-muted text-xs">{m.device_manage_guild_label()}</span>
      <Select
        value={zielGuild}
        options={guildOptionen}
        disabled={geraeteVerwaltung.laeuft}
        onchange={(v) => {
          zielGuild = v;
          umstellenGuild();
        }}
        data-testid="device-manage-guild"
      />
    </label>
    <label class="flex flex-col gap-1">
      <span class="text-text-muted text-xs">{m.device_manage_channel_label()}</span>
      <Select
        value={zielKanal}
        options={kanalOptionen}
        placeholder="—"
        disabled={geraeteVerwaltung.laeuft || sprachkanaele.length === 0}
        onchange={(v) => {
          zielKanal = v;
          umstellen();
        }}
        data-testid="device-manage-channel"
      />
    </label>
    {#if geraeteVerwaltung.geraeumteRollen > 0}
      <p class="text-text-muted text-xs" data-testid="device-manage-role-grants-cleared">
        {m.device_manage_role_grants_cleared({ count: geraeteVerwaltung.geraeumteRollen })}
      </p>
    {/if}
  {/if}

  {#if istBesitzer}
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
