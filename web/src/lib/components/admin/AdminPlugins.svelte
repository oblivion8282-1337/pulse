<!--
  Instanz-Allowlist für Plugins. Bootstrap-Admin-only Section auf der
  /app/admin Page. Listet jedes entdeckte Plugin + jeden Allowlist-Eintrag,
  dessen Plugin-Ordner verschwunden ist; Toggle pro Zeile setzt das
  Plugin via PUT/DELETE /admin/plugins/{name} auf erlaubt/nicht-erlaubt.

  `hello` ist hart in der Allowlist (Loader-Self-Heal beim Startup, DELETE
  → 409). Wir zeigen ihn als disabled mit Hinweis "Immer erlaubt
  (System-Plugin)".

  Wichtig: Allowlist-Mutationen wirken sich erst nach einem Service-
  Restart im Loader/Op-Gate aus (siehe Backend `routes/admin_plugins.py`).
  Der Toast nach jeder Aktion sagt das.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { toast } from 'svelte-sonner';
  import PuzzleIcon from '@lucide/svelte/icons/puzzle';
  import AlertTriangleIcon from '@lucide/svelte/icons/alert-triangle';
  import LockIcon from '@lucide/svelte/icons/lock';

  import {
    adminPluginsApi,
    type AdminPluginEntry
  } from '$lib/api/admin-plugins';

  const HELLO = 'hello';

  let rows = $state<AdminPluginEntry[]>([]);
  let loading = $state(true);
  let loadError = $state<string | null>(null);
  let busy = $state<Record<string, boolean>>({});

  onMount(async () => {
    await reload();
  });

  async function reload() {
    loading = true;
    try {
      rows = await adminPluginsApi.list();
      loadError = null;
    } catch (e) {
      loadError = e instanceof Error ? e.message : String(e);
    } finally {
      loading = false;
    }
  }

  async function toggle(name: string) {
    if (busy[name] || name === HELLO) return;
    const idx = rows.findIndex((r) => r.plugin_name === name);
    if (idx < 0) return;
    const target = !rows[idx].in_allowlist;
    busy[name] = true;
    // Optimistic flip.
    rows[idx] = { ...rows[idx], in_allowlist: target };
    try {
      if (target) {
        await adminPluginsApi.allow(name);
      } else {
        await adminPluginsApi.disallow(name);
      }
      // Stale-Eintrag (Plugin nicht mehr in Discovery, Allowlist soeben
      // entleert) komplett aus der Liste werfen — sonst hätten wir eine
      // tote Zeile, die der Admin nicht mehr "anstellen" kann.
      if (!target && !rows[idx].in_discovery) {
        rows = rows.filter((_, i) => i !== idx);
      }
      toast.success(
        target
          ? `Plugin "${name}" erlaubt — Restart aktiviert es im Loader`
          : `Plugin "${name}" nicht mehr erlaubt — Restart entlädt es`
      );
    } catch (e) {
      // Revert.
      rows[idx] = { ...rows[idx], in_allowlist: !target };
      toast.error('Allowlist-Update fehlgeschlagen', {
        description: e instanceof Error ? e.message : String(e)
      });
    } finally {
      busy[name] = false;
    }
  }
</script>

<section
  class="rounded-2xl border border-border bg-bg-input p-5"
  data-testid="admin-plugins"
>
  <div class="mb-4 flex items-start justify-between gap-3">
    <div class="min-w-0">
      <h2 class="text-text-bright text-base font-semibold">Plugins</h2>
      <p class="text-text-muted text-xs mt-0.5">
        Welche Plugins auf dieser Pulse-Instanz überhaupt geladen werden dürfen.
        Pro Server entscheiden Server-Admins separat über
        <em>Server-Einstellungen → Plugins</em>, welche der freigegebenen
        Plugins dort aktiv sind. Aktivierungen wirken erst nach einem
        Service-Restart.
      </p>
    </div>
  </div>

  {#if loading}
    <p class="text-text-muted text-sm">lade…</p>
  {:else if loadError}
    <p class="text-red-400 text-sm">Fehler: {loadError}</p>
  {:else if rows.length === 0}
    <div
      class="border-border bg-bg-hover/30 flex flex-col items-center gap-2 rounded-xl border p-6 text-center"
    >
      <PuzzleIcon class="text-text-muted size-8" />
      <p class="text-text-bright text-sm font-medium">Keine Plugins gefunden.</p>
      <p class="text-text-muted text-xs">
        Plugins liegen unter <code>plugins/&lt;name&gt;/</code>.
      </p>
    </div>
  {:else}
    <div class="flex flex-col gap-2">
      {#each rows as row (row.plugin_name)}
        {@const isHello = row.plugin_name === HELLO}
        {@const stale = !row.in_discovery}
        <div
          class="border-border bg-bg-hover/30 flex items-start justify-between gap-4 rounded-xl border p-3"
          data-testid="admin-plugin-row-{row.plugin_name}"
        >
          <div class="min-w-0 flex-1">
            <div class="flex items-center gap-2">
              <span class="text-text-bright text-sm font-medium">
                {row.plugin_name}
              </span>
              {#if row.version}
                <span class="text-text-muted text-xs">v{row.version}</span>
              {/if}
              {#if isHello}
                <span class="text-text-muted text-xs">· System-Plugin</span>
              {/if}
              {#if stale}
                <span
                  class="flex items-center gap-1 rounded-full bg-amber-500/20 px-1.5 py-0.5 text-xs text-amber-200"
                  title="Plugin-Verzeichnis fehlt — Eintrag bereinigen?"
                >
                  <AlertTriangleIcon class="size-3" /> verwaist
                </span>
              {/if}
            </div>
            {#if row.description}
              <div class="text-text-muted mt-0.5 text-xs">{row.description}</div>
            {:else if isHello}
              <div class="text-text-muted mt-0.5 text-xs">
                Loader-Smoketest. Immer erlaubt, kann nicht entfernt werden.
              </div>
            {/if}
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={row.in_allowlist}
            aria-label={row.plugin_name}
            disabled={isHello || busy[row.plugin_name]}
            onclick={() => toggle(row.plugin_name)}
            data-testid="admin-plugin-toggle-{row.plugin_name}"
            class="relative inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full transition-colors disabled:cursor-not-allowed
                   {row.in_allowlist ? 'bg-primary' : 'bg-bg-hover'}
                   {isHello ? 'opacity-60' : ''}"
          >
            <span
              class="inline-block size-4 transform rounded-full bg-white transition-transform
                     {row.in_allowlist ? 'translate-x-6' : 'translate-x-1'}"
            ></span>
            {#if isHello}
              <LockIcon
                class="text-text-muted pointer-events-none absolute right-1 size-3"
              />
            {/if}
          </button>
        </div>
      {/each}
    </div>
  {/if}
</section>
