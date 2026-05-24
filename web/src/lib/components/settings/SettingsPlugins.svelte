<script lang="ts">
  import { onMount } from 'svelte';
  import {
    conflictKindLabel,
    detectConflicts,
    listPlugins,
    pluginActivation,
    setPluginActivated,
    type Conflict,
    type PluginRecord
  } from '$lib/plugins';
  import { toast } from 'svelte-sonner';
  import PuzzleIcon from '@lucide/svelte/icons/puzzle';
  import AlertTriangleIcon from '@lucide/svelte/icons/alert-triangle';
  import RefreshCwIcon from '@lucide/svelte/icons/refresh-cw';

  // Snapshot der Plugin-Records — der Registry-State ist nicht rune-tracked,
  // aber Aktivierungs-Toggles ändern nur das `activated`-Feld (das wir aus
  // `pluginActivation.activated` reaktiv ableiten), nicht die Plugin-Liste
  // selbst. Hot-Reload eines neuen Plugins ohne Page-Refresh ist Schritt 6+.
  let records = $state<PluginRecord[]>([]);
  let busy = $state<Record<string, boolean>>({});

  onMount(() => {
    records = listPlugins().sort((a, b) =>
      a.manifest.name.localeCompare(b.manifest.name)
    );
  });

  // Aktiv-Set leitet sich aus dem persistierten Section-State ab — so flippt
  // ein Toggle sofort die Karte, ohne dass wir die Records re-fetchen müssen.
  const activeSet = $derived(new Set(pluginActivation.activated));

  const conflicts = $derived<Conflict[]>(
    detectConflicts(
      records.map((r) => r.manifest),
      activeSet
    )
  );

  const conflictsByName = $derived(() => {
    const out: Record<string, Conflict[]> = {};
    for (const c of conflicts) {
      for (const p of c.plugins) {
        out[p] = out[p] ?? [];
        out[p].push(c);
      }
    }
    return out;
  });

  async function toggle(name: string) {
    if (busy[name]) return;
    busy[name] = true;
    const target = !activeSet.has(name);
    try {
      await setPluginActivated(name, target);
      toast.success(target ? `${name} aktiviert` : `${name} deaktiviert`);
    } catch (err) {
      console.error(`[plugins] ${name}: toggle failed`, err);
      toast.error(
        `Konnte ${name} nicht ${target ? 'aktivieren' : 'deaktivieren'}: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    } finally {
      busy[name] = false;
    }
  }

  function refresh() {
    records = listPlugins().sort((a, b) =>
      a.manifest.name.localeCompare(b.manifest.name)
    );
  }

  function usesSummary(rec: PluginRecord) {
    const u = rec.manifest.uses;
    return [
      { kind: 'ws_ops' as const, items: u.ws_ops },
      { kind: 'channels' as const, items: u.channels },
      { kind: 'settings_sections' as const, items: u.settings_sections },
      { kind: 'ui_slots' as const, items: u.ui_slots }
    ].filter((g) => g.items.length > 0);
  }
</script>

<div class="flex flex-col gap-5" data-testid="settings-plugins-panel">
  <div class="flex items-start justify-between gap-3">
    <div class="flex flex-col gap-1">
      <h2 class="text-text-bright text-lg font-semibold">Plugins</h2>
      <p class="text-text-muted text-sm">
        Installierte Pulse-Plugins, ihre Schnittstellen und Konflikte. Aktivierungen
        werden persistiert und überleben den Reload.
      </p>
    </div>
    <button
      type="button"
      onclick={refresh}
      class="text-text-muted hover:bg-bg-hover hover:text-text-bright shrink-0 rounded-lg p-2 transition-colors"
      aria-label="Plugin-Liste neu laden"
      data-testid="plugins-refresh"
    >
      <RefreshCwIcon class="size-4" />
    </button>
  </div>

  {#if records.length === 0}
    <section
      class="border-border bg-bg-input/40 flex flex-col items-center gap-2 rounded-2xl border p-6 text-center"
    >
      <PuzzleIcon class="text-text-muted size-8" />
      <p class="text-text-bright text-sm font-medium">Keine Plugins installiert.</p>
      <p class="text-text-muted text-xs">
        Plugins liegen unter <code>plugins/&lt;name&gt;/</code>. Spec:
        <a class="text-primary hover:underline" href="https://github.com/oblivion8282-1337/pulse/blob/main/docs/PLUGIN_MANIFEST.md">PLUGIN_MANIFEST.md</a>.
      </p>
    </section>
  {:else}
    {#if conflicts.length > 0}
      <section
        class="flex flex-col gap-2 rounded-2xl border border-amber-500/40 bg-amber-500/10 p-4"
        data-testid="plugins-conflicts"
      >
        <div class="flex items-center gap-2">
          <AlertTriangleIcon class="size-4 shrink-0 text-amber-500" />
          <span class="text-text-bright text-sm font-medium">
            {conflicts.length}
            {conflicts.length === 1 ? 'Konflikt' : 'Konflikte'} zwischen aktiven Plugins
          </span>
        </div>
        <ul class="flex flex-col gap-1 pl-6 text-xs text-text-muted">
          {#each conflicts as c (`${c.kind}:${c.resource}`)}
            <li>
              <span class="font-mono text-text-bright">{c.resource}</span>
              <span class="text-text-muted"> ({conflictKindLabel(c.kind)})</span>
              <span class="text-text-muted"> — geteilt von </span>
              <span class="text-text-bright">{c.plugins.join(', ')}</span>
            </li>
          {/each}
        </ul>
      </section>
    {/if}

    <div class="flex flex-col gap-3">
      {#each records as rec (rec.manifest.name)}
        {@const isActive = activeSet.has(rec.manifest.name)}
        {@const groups = usesSummary(rec)}
        {@const pluginConflicts = conflictsByName()[rec.manifest.name] ?? []}
        <article
          class="border-border bg-bg-input/40 flex flex-col gap-3 rounded-2xl border p-4"
          data-testid="plugin-card-{rec.manifest.name}"
        >
          <div class="flex items-start justify-between gap-3">
            <div class="flex min-w-0 flex-col gap-1">
              <div class="flex flex-wrap items-baseline gap-2">
                <span class="text-text-bright text-sm font-semibold">{rec.manifest.name}</span>
                <span class="text-text-muted text-xs">v{rec.manifest.version}</span>
                {#if rec.manifest.author}
                  <span class="text-text-muted text-xs">— {rec.manifest.author}</span>
                {/if}
                {#if rec.failedActivate}
                  <span class="rounded-full bg-destructive/20 px-2 py-0.5 text-xs text-destructive">
                    Fehler beim Aktivieren
                  </span>
                {/if}
              </div>
              {#if rec.manifest.description}
                <p class="text-text-muted text-xs">{rec.manifest.description}</p>
              {/if}
            </div>
            <button
              type="button"
              onclick={() => toggle(rec.manifest.name)}
              disabled={busy[rec.manifest.name]}
              aria-pressed={isActive}
              class="shrink-0 rounded-full px-3 py-2 text-xs font-medium transition-colors md:py-1.5 {isActive
                ? 'accent-gradient text-white'
                : 'bg-bg-hover text-text-bright hover:bg-bg-input'} disabled:cursor-not-allowed disabled:opacity-50"
              data-testid="plugin-toggle-{rec.manifest.name}"
            >
              {busy[rec.manifest.name] ? '…' : isActive ? 'Aktiv' : 'Inaktiv'}
            </button>
          </div>

          {#if groups.length > 0}
            <div class="flex flex-col gap-2">
              {#each groups as g (g.kind)}
                <div class="flex flex-wrap items-center gap-1.5">
                  <span class="text-text-muted text-xs uppercase tracking-wide">
                    {conflictKindLabel(g.kind)}
                  </span>
                  {#each g.items as item (item)}
                    {@const isShared = pluginConflicts.some(
                      (c) => c.kind === g.kind && c.resource === item
                    )}
                    <span
                      class="font-mono text-xs rounded-md px-1.5 py-0.5 {isShared
                        ? 'bg-amber-500/20 text-amber-200 ring-1 ring-amber-500/40'
                        : 'bg-bg-hover text-text-bright'}"
                      title={isShared ? 'Konflikt mit anderem aktiven Plugin' : undefined}
                    >
                      {item}
                    </span>
                  {/each}
                </div>
              {/each}
            </div>
          {:else}
            <p class="text-text-muted text-xs italic">
              Keine deklarierten Schnittstellen — backend-only oder inaktiv.
            </p>
          {/if}

          {#if pluginConflicts.length > 0}
            <div class="flex flex-col gap-1 rounded-xl bg-amber-500/10 p-2 text-xs">
              <div class="flex items-center gap-1.5 text-amber-200">
                <AlertTriangleIcon class="size-3" />
                <span class="font-medium">Geteilte Slots</span>
              </div>
              {#each pluginConflicts as c (`${c.kind}:${c.resource}`)}
                <div class="text-text-muted">
                  <span class="font-mono text-text-bright">{c.resource}</span>
                  — auch genutzt von
                  <span class="text-text-bright">
                    {c.plugins.filter((p) => p !== rec.manifest.name).join(', ')}
                  </span>
                </div>
              {/each}
            </div>
          {/if}
        </article>
      {/each}
    </div>
  {/if}
</div>
