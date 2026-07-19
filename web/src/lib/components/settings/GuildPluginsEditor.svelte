<!--
  Pro-Guild Plugin-Aktivierungs-Editor. MANAGE_GUILD-gated Tab im
  GuildSettingsDialog. Listet alle vom Bootstrap-Admin freigegebenen
  Plugins (Allowlist) und erlaubt pro Server Toggle-EIN/AUS.

  `hello` ist instanzweit aktiv (Loader-Smoketest) und wird vom Backend
  immer mit `enabled: true` geliefert. PUT auf `hello` → 409, deshalb
  zeigen wir den Toggle disabled mit Hinweis "Immer aktiv (System-Plugin)".

  Optimistic UI: Toggle flippt sofort, bei Fehler wird zurückgerollt.
  Nach erfolgreichem PUT patcht der Editor zusätzlich den lokalen
  `guild-activation`-Store, damit z.B. das Tamagotchi-Widget im
  SidebarFooter ohne Reload erscheint/verschwindet.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { toast } from 'svelte-sonner';
  import PuzzleIcon from '@lucide/svelte/icons/puzzle';
  import LockIcon from '@lucide/svelte/icons/lock';

  import {
    guildPluginsApi,
    type GuildPluginEntry
  } from '$lib/api/guild-plugins';
  import { setGuildPluginEnabled } from '$lib/plugins';
  import { m } from '$lib/paraglide/messages.js';

  const HELLO = 'hello';

  let { guildId }: { guildId: string } = $props();

  let rows = $state<GuildPluginEntry[]>([]);
  let loading = $state(true);
  let loadError = $state<string | null>(null);
  let busy = $state<Record<string, boolean>>({});

  onMount(async () => {
    try {
      rows = await guildPluginsApi.list(guildId);
    } catch (e) {
      loadError = e instanceof Error ? e.message : String(e);
    } finally {
      loading = false;
    }
  });

  async function toggle(name: string) {
    if (busy[name] || name === HELLO) return;
    const idx = rows.findIndex((r) => r.plugin_name === name);
    if (idx < 0) return;
    const target = !rows[idx].enabled;
    busy[name] = true;
    // Optimistic flip — der Editor zeigt den Zielzustand sofort.
    rows[idx] = { ...rows[idx], enabled: target };
    try {
      const updated = await guildPluginsApi.toggle(guildId, name, target);
      rows[idx] = updated;
      setGuildPluginEnabled(guildId, name, updated.enabled);
      toast.success(
        updated.enabled
          ? m.guild_plugins_editor_plugin_activated({ name })
          : m.guild_plugins_editor_plugin_deactivated({ name })
      );
    } catch (e) {
      // Revert.
      rows[idx] = { ...rows[idx], enabled: !target };
      toast.error(m.guild_plugins_editor_toggle_failed(), {
        description: e instanceof Error ? e.message : String(e)
      });
    } finally {
      busy[name] = false;
    }
  }
</script>

<section class="flex flex-col gap-5" data-testid="guild-plugins-panel">
  <div class="flex flex-col gap-1">
    <h2 class="text-text-bright text-lg font-semibold">{m.guild_plugins_editor_title()}</h2>
    <p class="text-text-muted text-sm">
      {m.guild_plugins_editor_description()}
    </p>
  </div>

  {#if loading}
    <p class="text-text-muted text-sm">{m.guild_plugins_editor_loading()}</p>
  {:else if loadError}
    <p class="text-destructive text-sm" data-testid="guild-plugins-error">
      {m.guild_plugins_editor_load_error({ message: loadError ?? '' })}
    </p>
  {:else if rows.length === 0}
    <div
      class="border-border bg-bg-input/40 flex flex-col items-center gap-2 rounded-2xl border p-6 text-center"
    >
      <PuzzleIcon class="text-text-muted size-8" />
      <p class="text-text-bright text-sm font-medium">
        {m.guild_plugins_editor_none_allowed()}
      </p>
      <p class="text-text-muted text-xs">
        {m.guild_plugins_editor_none_allowed_hint()}
      </p>
    </div>
  {:else}
    <div class="flex flex-col gap-2">
      {#each rows as row (row.plugin_name)}
        {@const isHello = row.plugin_name === HELLO}
        <div
          class="border-border bg-bg-hover/30 flex items-start justify-between gap-4 rounded-xl border p-3"
          data-testid="guild-plugin-row-{row.plugin_name}"
        >
          <div class="min-w-0 flex-1">
            <div class="text-text-bright text-sm font-medium">
              {row.plugin_name}
              {#if isHello}
                <span class="text-text-muted text-xs font-normal">
                  · {m.guild_plugins_editor_system_plugin()}
                </span>
              {/if}
            </div>
            <div class="text-text-muted mt-0.5 text-xs">
              {#if isHello}
                {m.guild_plugins_editor_hello_description()}
              {:else if row.enabled}
                {m.guild_plugins_editor_row_enabled()}
              {:else}
                {m.guild_plugins_editor_row_disabled()}
              {/if}
            </div>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={row.enabled}
            aria-label={row.plugin_name}
            disabled={isHello || busy[row.plugin_name]}
            onclick={() => toggle(row.plugin_name)}
            data-testid="guild-plugin-toggle-{row.plugin_name}"
            class="relative inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full transition-colors disabled:cursor-not-allowed
                   {row.enabled ? 'bg-primary' : 'bg-bg-hover'}
                   {isHello ? 'opacity-60' : ''}"
          >
            <span
              class="inline-block size-4 transform rounded-full bg-white transition-transform
                     {row.enabled ? 'translate-x-6' : 'translate-x-1'}"
            ></span>
            {#if isHello}
              <LockIcon class="text-text-muted pointer-events-none absolute right-1 size-3" />
            {/if}
          </button>
        </div>
      {/each}
    </div>
  {/if}
</section>
