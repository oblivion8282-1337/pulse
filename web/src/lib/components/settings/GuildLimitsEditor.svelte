<!--
  Die Community stellt ihre eigenen Grenzen ein (MANAGE_GUILD).

  Fährt PATCH /guilds/{id}/limits — dieselben Limits wie das Betreiber-Panel,
  aber jeder Wert wird serverseitig auf die Vorgabe des Betreibers geklemmt.
  Der Platzhalter jedes Feldes nennt diese Vorgabe, damit sichtbar ist, in
  welchem Rahmen man sich bewegt. Leer = „nimm die Vorgabe".

  Gruppierung wie im Betreiber-Panel: Qualität, Dateien & Speicher, Größe.
-->
<script lang="ts">
  import { toast } from 'svelte-sonner';
  import { chatApi, type GuildLimits } from '$lib/api/chat';
  import { Button } from '$lib/components/ui/button/index.js';
  import { m } from '$lib/paraglide/messages.js';
  import LoadingState from '$lib/components/feedback/LoadingState.svelte';
  import GuildLimitRow from './GuildLimitRow.svelte';
  import { toDisplay, toWire, type LimitKind } from './guildLimitUnits';

  let { guildId }: { guildId: string } = $props();

  // Feldtabelle: Schlüssel (muss zum Backend passen) + Einheit, in Gruppen.
  type Field = { key: string; kind: LimitKind; label: () => string };
  const GROUPS: { title: string; fields: Field[] }[] = [
    {
      title: m.guild_limits_group_quality(),
      fields: [
        { key: 'voice_bitrate_kbps', kind: 'raw', label: m.guild_limits_field_voice_bitrate_kbps },
        { key: 'stream_bitrate_kbps', kind: 'mbps', label: m.guild_limits_field_stream_bitrate_kbps },
        { key: 'stream_fps', kind: 'raw', label: m.guild_limits_field_stream_fps },
        { key: 'stream_resolution', kind: 'resolution', label: m.guild_limits_field_stream_resolution }
      ]
    },
    {
      title: m.guild_limits_group_files(),
      fields: [
        { key: 'attachment_max_size_bytes', kind: 'mb', label: m.guild_limits_field_attachment_max_size_bytes },
        { key: 'attachment_max_count_per_message', kind: 'raw', label: m.guild_limits_field_attachment_max_count_per_message },
        { key: 'attachment_storage_quota_bytes', kind: 'gb', label: m.guild_limits_field_attachment_storage_quota_bytes }
      ]
    },
    {
      title: m.guild_limits_group_scale(),
      fields: [
        { key: 'max_members', kind: 'raw', label: m.guild_limits_field_max_members },
        { key: 'max_channels', kind: 'raw', label: m.guild_limits_field_max_channels },
        { key: 'max_roles', kind: 'raw', label: m.guild_limits_field_max_roles },
        { key: 'max_devices_per_owner', kind: 'raw', label: m.guild_limits_field_max_devices },
        { key: 'max_concurrent_streams', kind: 'raw', label: m.guild_limits_field_max_concurrent_streams }
      ]
    }
  ];
  const FIELDS = GROUPS.flatMap((g) => g.fields);

  let data = $state<GuildLimits | null>(null);
  // Anzeige-Werte je Schlüssel ('' = nichts gesetzt).
  let inputs = $state<Record<string, string>>({});
  let busy = $state(false);

  // Felder aus dem eigenen Wert der Community seeden (nicht aus dem wirksamen —
  // leer soll „erbt die Vorgabe" heißen, nicht die Vorgabe als eigenen Wert
  // einfrieren). Beim Laden UND nach dem Speichern, da der Server dort die
  // geklemmten Werte zurückgibt.
  function seed(res: GuildLimits): void {
    inputs = Object.fromEntries(
      FIELDS.map((f) => [f.key, toDisplay(res.limits[f.key]?.value ?? null, f.kind)])
    );
  }

  $effect(() => {
    void guildId;
    data = null;
    chatApi
      .getGuildLimits(guildId)
      .then((res) => {
        data = res;
        seed(res);
      })
      .catch((e) =>
        toast.error(m.guild_limits_save_failed(), {
          description: e instanceof Error ? e.message : String(e)
        })
      );
  });

  async function save() {
    if (busy) return;
    busy = true;
    try {
      const payload = Object.fromEntries(
        FIELDS.map((f) => [f.key, toWire(inputs[f.key] ?? '', f.kind)])
      );
      const res = await chatApi.patchGuildLimits(guildId, payload);
      data = res;
      // Nach dem Klemmen die Felder auf die tatsächlich gespeicherten Werte
      // zurücksetzen, sonst zeigt das Feld weiter den abgelehnten Wunsch.
      seed(res);
      if (res.clamped.length) toast.warning(m.guild_limits_clamped());
      else toast.success(m.guild_limits_saved());
    } catch (e) {
      toast.error(m.guild_limits_save_failed(), {
        description: e instanceof Error ? e.message : String(e)
      });
    } finally {
      busy = false;
    }
  }
</script>

<section class="flex flex-col gap-5" data-testid="guild-limits-editor">
  <div>
    <h2 class="text-text-bright text-base font-semibold">{m.guild_limits_title()}</h2>
    <p class="text-text-muted text-xs">{m.guild_limits_subtitle()}</p>
  </div>

  {#if !data}
    <LoadingState label={m.guild_limits_loading()} />
  {:else}
    {#each GROUPS as group (group.title)}
      <div class="flex flex-col gap-3">
        <h3 class="text-text-bright text-sm font-semibold">{group.title}</h3>
        <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {#each group.fields as field (field.key)}
            <GuildLimitRow
              label={field.label()}
              kind={field.kind}
              ceiling={data.limits[field.key]?.ceiling ?? null}
              testid={`guild-limit-${field.key}`}
              bind:value={inputs[field.key]}
            />
          {/each}
        </div>
      </div>
    {/each}

    <div class="flex justify-end">
      <Button onclick={save} disabled={busy} data-testid="guild-limits-save">
        {busy ? m.guild_limits_saving() : m.guild_limits_save()}
      </Button>
    </div>
  {/if}
</section>
