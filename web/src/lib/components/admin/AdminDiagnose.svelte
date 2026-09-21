<!--
  Admin: Diagnose-Berichte lesen (Spec 2026-09-21 §6). Super-Admin only —
  das Backend riegelt zusätzlich ab (_require_admin + _require_cloud).

  Liste (neueste zuerst, Filter nach Quelle) → Klick öffnet das Detail:
  App-Berichte als Kopf/Ereignisliste/Notiz, Server-Pakete zusätzlich mit
  allen Paket-Blöcken (Setup-Checkliste, Neustart-Zähler, Backups,
  Konfiguration, Cloud-Check, Bootstrap-Logs). Löschen ist bewusst
  Einzellösung — der reguläre Abwurf ist die 28-Tage-Frist im Endpoint.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { Button } from '$lib/components/ui/button';
  import * as Alert from '$lib/components/ui/alert/index.js';
  import LoadingState from '$lib/components/feedback/LoadingState.svelte';
  import ScrollTextIcon from '@lucide/svelte/icons/scroll-text';
  import { m } from '$lib/paraglide/messages.js';
  import {
    adminDiagnoseApi,
    type DiagnoseDetails,
    type DiagnoseListeEintrag,
    type DiagnoseRolleFilter
  } from '$lib/api/diagnose';

  let zeilen = $state<DiagnoseListeEintrag[]>([]);
  let laedt = $state(true);
  let fehler = $state<string | null>(null);
  /** Fehler von Detail-Laden/-Löschen — BEWUSST getrennt vom Listen-Fehler:
   *  ein gescheiterter Detail-Abruf darf nicht die ganze Liste ersetzen. */
  let detailFehler = $state<string | null>(null);
  let rolle = $state<DiagnoseRolleFilter>('');
  let details = $state<DiagnoseDetails | null>(null);

  const rollen: { id: DiagnoseRolleFilter; label: string }[] = [
    { id: '', label: m.admin_diagnose_filter_alle() },
    { id: 'app', label: 'App' },
    { id: 'viewer', label: m.admin_diagnose_rolle_viewer() },
    { id: 'sender', label: m.admin_diagnose_rolle_sender() },
    { id: 'server', label: 'Server' }
  ];

  async function laden(): Promise<void> {
    laedt = true;
    fehler = null;
    try {
      zeilen = await adminDiagnoseApi.list(rolle);
    } catch {
      fehler = m.admin_diagnose_laden_fehler();
    } finally {
      laedt = false;
    }
  }

  function rolleWechseln(neu: DiagnoseRolleFilter): void {
    if (rolle === neu) return;
    rolle = neu;
    details = null;
    detailFehler = null;
    void laden();
  }

  async function oeffnen(id: string): Promise<void> {
    detailFehler = null;
    details = null;
    try {
      details = await adminDiagnoseApi.hole(id);
    } catch {
      detailFehler = m.admin_diagnose_laden_fehler();
    }
  }

  async function loeschen(id: string): Promise<void> {
    detailFehler = null;
    try {
      await adminDiagnoseApi.loeschen(id);
      zeilen = zeilen.filter((z) => z.id !== id);
      details = null;
    } catch {
      detailFehler = m.admin_diagnose_laden_fehler();
    }
  }

  function zeit(iso: string): string {
    return new Date(iso).toLocaleString();
  }

  // Die Ereignisliste des Berichts ist dynamisch (alter Sender-Report hat
  // andere Felder als der App-Bericht) — hier defensiv lesen statt Typen
  // zu behaupten, die der Sender nicht garantiert.
  function ereignisse(d: DiagnoseDetails): { s: number; art: string; anzahl: number }[] {
    const liste = (d.report as { ereignisse?: unknown } | null)?.ereignisse;
    return Array.isArray(liste) ? (liste as { s: number; art: string; anzahl: number }[]) : [];
  }

  function notiz(d: DiagnoseDetails): string | null {
    const notiz = (d.report as { abschluss?: { notiz?: unknown } } | null)?.abschluss?.notiz;
    return typeof notiz === 'string' && notiz.trim() ? notiz : null;
  }

  function verworfen(d: DiagnoseDetails): number | null {
    const n = (d.report as { ereignisse_verworfen?: unknown } | null)?.ereignisse_verworfen;
    return typeof n === 'number' ? n : null;
  }

  /** Server-Paket-Blöcke (setup_status, abstuerze, backups, konfiguration,
   *  cloud, bootstrap_logs) — generisch gelesen, damit neue Blöcke im
   *  Sender ohne UI-Deploy sichtbar bleiben. */
  function paketBloecke(d: DiagnoseDetails): { name: string; inhalt: unknown }[] {
    if (d.role !== 'server') return [];
    const report = d.report as Record<string, unknown> | null;
    if (!report) return [];
    const fix = new Set(['ereignisse', 'abschluss', 'ereignisse_verworfen', 'bilanz']);
    return Object.entries(report)
      .filter(([name, wert]) => !fix.has(name) && wert != null)
      .map(([name, wert]) => ({ name, inhalt: wert }));
  }

  onMount(laden);
</script>

<div data-testid="admin-diagnose">
  <!-- Quellen-Filter -->
  <div class="mb-3 flex flex-wrap gap-1">
    {#each rollen as r (r.id)}
      <button
        type="button"
        onclick={() => rolleWechseln(r.id)}
        class="border-border rounded-full border px-3 py-1 text-xs transition-colors {rolle === r.id
          ? 'bg-primary text-primary-foreground'
          : 'text-text-muted hover:text-text-base'}"
        data-testid="diagnose-filter-{r.id || 'alle'}"
      >
        {r.label}
      </button>
    {/each}
  </div>

  {#if laedt}
    <LoadingState label={m.admin_diagnose_lade()} />
  {:else if fehler}
    <Alert.Root variant="destructive">
      <Alert.Description>{fehler}</Alert.Description>
    </Alert.Root>
  {:else if zeilen.length === 0}
    <p class="text-text-muted text-sm" data-testid="diagnose-leer">{m.admin_diagnose_leer()}</p>
  {:else}
    <div class="overflow-x-auto">
      <table class="w-full text-left text-sm">
        <thead>
          <tr class="text-text-muted border-border border-b text-xs uppercase">
            <th class="py-2 pr-4">{m.admin_diagnose_zeit()}</th>
            <th class="py-2 pr-4">{m.admin_diagnose_rolle()}</th>
            <th class="py-2 pr-4">{m.admin_diagnose_grund()}</th>
            <th class="py-2">{m.admin_diagnose_kanal()}</th>
          </tr>
        </thead>
        <tbody>
          {#each zeilen as z (z.id)}
            <!-- Klickbare Zeile mit Tastaturweg: Zeilen-onclick allein wäre
                 für Tastatur-/Screenreader-Nutzer unerreichbar. -->
            <tr
              class="border-border hover:bg-bg-hover cursor-pointer border-b transition-colors"
              tabindex="0"
              role="button"
              onclick={() => oeffnen(z.id)}
              onkeydown={(e) => (e.key === 'Enter' || e.key === ' ') && oeffnen(z.id)}
              data-testid="diagnose-zeile"
            >
              <td class="py-2 pr-4 whitespace-nowrap">{zeit(z.created_at)}</td>
              <td class="py-2 pr-4">{z.role ?? '—'}</td>
              <td class="py-2 pr-4 font-mono text-xs">{z.reason ?? '—'}</td>
              <td class="text-text-muted py-2 font-mono text-xs">{z.channel_id ?? '—'}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}

  {#if detailFehler}
    <div class="mt-3">
      <Alert.Root variant="destructive">
        <Alert.Description>{detailFehler}</Alert.Description>
      </Alert.Root>
    </div>
  {/if}

  {#if details}
    <div
      class="border-border bg-bg-hover mt-4 space-y-3 rounded-xl border p-4"
      data-testid="diagnose-details"
    >
      <div class="flex items-center justify-between">
        <h3 class="text-text-bright flex items-center gap-2 text-sm font-semibold">
          <ScrollTextIcon class="size-4" />
          {m.admin_diagnose_details()} · {details.id}
        </h3>
        <Button variant="ghost" size="sm" onclick={() => (details = null)}>✕</Button>
      </div>

      {#if notiz(details)}
        <div class="border-border rounded-lg border p-3">
          <p class="text-text-muted text-xs font-semibold uppercase">{m.admin_diagnose_notiz()}</p>
          <p class="text-text-bright mt-1 text-sm whitespace-pre-wrap">{notiz(details)}</p>
        </div>
      {/if}

      <div class="grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
        <div><span class="text-text-muted block">{m.admin_diagnose_zeit()}</span>{zeit(details.created_at)}</div>
        <div><span class="text-text-muted block">{m.admin_diagnose_rolle()}</span>{details.role ?? '—'}</div>
        <div><span class="text-text-muted block">IP</span>{details.client_ip ?? '—'}</div>
        <div><span class="text-text-muted block">Version</span>{details.sidecar_version ?? '—'}</div>
      </div>

      <div>
        <p class="text-text-muted text-xs font-semibold uppercase">{m.admin_diagnose_kopf()}</p>
        <pre class="bg-bg-input border-border mt-1 overflow-x-auto rounded-lg border p-2 text-xs">{JSON.stringify(
          details.system_info,
          null,
          2
        )}</pre>
      </div>

      {#if ereignisse(details).length > 0}
        <div>
          <p class="text-text-muted text-xs font-semibold uppercase">
            {m.admin_diagnose_ereignisse()} ({ereignisse(details).length}{verworfen(details)
              ? `; ${verworfen(details)} ${m.admin_diagnose_verworfen()}`
              : ''})
          </p>
          <ul class="mt-1 space-y-0.5 font-mono text-xs">
            {#each ereignisse(details) as e, i (i)}
              <li>t+{e.s}s · {e.art}{e.anzahl > 1 ? ` ×${e.anzahl}` : ''}</li>
            {/each}
          </ul>
        </div>
      {/if}

      {#each paketBloecke(details) as block, i (i)}
        <div>
          <p class="text-text-muted text-xs font-semibold uppercase">{block.name}</p>
          {#if Array.isArray(block.inhalt)}
            <ul class="mt-1 space-y-0.5 font-mono text-xs">
              {#each block.inhalt as zeile, j (j)}
                <li>{typeof zeile === 'string' ? zeile : JSON.stringify(zeile)}</li>
              {/each}
            </ul>
          {:else}
            <pre class="bg-bg-input border-border mt-1 max-h-64 overflow-auto rounded-lg border p-2 text-xs">{JSON.stringify(block.inhalt, null, 2)}</pre>
          {/if}
        </div>
      {/each}

      {#if details.log_text}
        <div>
          <p class="text-text-muted text-xs font-semibold uppercase">{m.admin_diagnose_log()}</p>
          <pre class="bg-bg-input border-border mt-1 max-h-64 overflow-auto rounded-lg border p-2 text-xs">{details.log_text}</pre>
        </div>
      {/if}

      <div class="flex justify-end">
        <Button variant="ghost" size="sm" onclick={() => loeschen(details!.id)}>
          {m.admin_diagnose_loeschen()}
        </Button>
      </div>
    </div>
  {/if}
</div>
