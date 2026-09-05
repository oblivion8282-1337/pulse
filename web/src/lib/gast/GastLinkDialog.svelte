<script lang="ts">
  /**
   * Gast-Links eines Sprachkanals: erzeugen (mit Zeitfenster), sehen, entwerten.
   *
   * Der Code steht nur EINMAL da — direkt nach dem Erzeugen. Serverseitig
   * liegt nur sein Hash, es gibt ihn danach nirgends mehr. Deshalb der
   * Hinweis und der Kopieren-Knopf gleich daneben.
   *
   * Die Liste trennt AKTIV von ENTWERTET: die entwerteten klappen zu und
   * tragen nur ihre Anzahl — bei einer Besprechung mit viel Einladverkehr
   * wächst sonst ein endloser Graubereich, in dem der aktive Link
   * untergeht. Abgelaufene stehen gar nicht erst drin (der Server liefert
   * sie nicht).
   */
  import * as Dialog from '$lib/components/ui/dialog/index.js';
  import { Button } from '$lib/components/ui/button';
  import { toast } from 'svelte-sonner';
  import { m } from '$lib/paraglide/messages.js';
  import ChevronDownIcon from '@lucide/svelte/icons/chevron-down';
  import ChevronUpIcon from '@lucide/svelte/icons/chevron-up';
  import {
    createGastLink,
    gastLinkUrl,
    listGastLinks,
    revokeGastLink,
    type GastLink
  } from '$lib/api/gastLinks';

  let {
    open = $bindable(false),
    channelId,
    guildId
  }: { open: boolean; channelId: string; guildId: string } = $props();

  let links = $state<GastLink[]>([]);
  let frischerCode = $state<string | null>(null);
  let laedt = $state(false);
  let erloschenOffen = $state(false);
  /** Link-IDs, deren Entwertung gerade läuft — Doppelklick schickt sonst
   *  zwei DELETEs (der zweite läuft in einen 404 und toastet Unsinn). */
  let entwertetLaeuft = $state<Set<string>>(new Set());

  // Zeitfenster der NEUEN Links. Die Felder sind datetime-local (lokale
  // Zeit); verschickt wird ISO mit Zonen-Suffix (``toISOString``), damit der
  // Server die Zeiten eindeutig einordnen kann. „Ab" leer = ab sofort; die
  // Chips setzen „bis" auf jetzt + Dauer.
  let gueltigBis = $state<string>('');
  let gueltigAb = $state<string>('');

  const DAUER = [
    { stunden: 1, label: () => m.gast_links_dauer_1h() },
    { stunden: 8, label: () => m.gast_links_dauer_8h() },
    { stunden: 24, label: () => m.gast_links_dauer_24h() },
    { stunden: 24 * 3, label: () => m.gast_links_dauer_3d() },
    { stunden: 24 * 7, label: () => m.gast_links_dauer_7d() }
  ];
  let dauer = $state(24);

  $effect(() => {
    if (!open) return;
    frischerCode = null;
    erloschenOffen = false;
    dauer = 24;
    gueltigAb = '';
    gueltigBis = bisFormat(new Date(Date.now() + 24 * 3600 * 1000));
    void laden();
  });

  /** datetime-local braucht „JJJJ-MM-TTTHH:MM" in LOCALER Zeit. */
  function bisFormat(d: Date): string {
    const p = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  function dauerWaehlen(stunden: number): void {
    dauer = stunden;
    gueltigBis = bisFormat(new Date(Date.now() + stunden * 3600 * 1000));
    gueltigAb = '';
  }

  let bisIso = $derived.by(() => {
    if (!gueltigBis) return null;
    const d = new Date(gueltigBis);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  });
  let abIso = $derived.by(() => {
    if (!gueltigAb) return null;
    const d = new Date(gueltigAb);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  });
  // Ein „bis“ in der VERGANGENHEIT erzeugt sonst einen sofort toten Link,
  // dessen Code der Gastgeber genau einmal angezeigt bekommt — die Liste
  // zeigt ihn nie (serverseitig abgelaufen). Deshalb hier abwehren.
  let eingabeOk = $derived.by(() => {
    if (abIso && bisIso && abIso >= bisIso) return false;
    if (bisIso && bisIso <= new Date().toISOString()) return false;
    return true;
  });

  async function laden() {
    try {
      const alle = await listGastLinks(guildId);
      links = alle.filter((l) => l.channel_id === channelId);
    } catch {
      links = [];
    }
  }

  async function erzeugen() {
    if (!eingabeOk) return;
    laedt = true;
    try {
      const link = await createGastLink(channelId, {
        // Absolutes „bis“ gewinnt serverseitig ohnehin — die Stunden werden
        // nur als Rückfall geschickt, wenn „bis“ leer bleibt.
        gueltigStunden: bisIso ? undefined : dauer,
        gueltigAb: abIso,
        gueltigBis: bisIso
      });
      frischerCode = link.code ?? null;
      await laden();
      if (frischerCode) await kopieren(frischerCode);
    } catch (e) {
      // Ohne dieses Catch würde ein 400/429 als unbehandelte Rejection
      // verschwinden: der Gastgeber sieht „nichts passiert“, dabei war die
      // Erzeugung fehlgeschlagen (z. B. Rate-Limit).
      toast.error((e as Error).message || m.gast_fehler_allgemein());
    } finally {
      laedt = false;
    }
  }

  async function kopieren(code: string) {
    try {
      await navigator.clipboard.writeText(gastLinkUrl(code));
      toast.success(m.gast_links_kopiert());
    } catch {
      // Zwischenablage verweigert (kein sicherer Kontext, kein Nutzerklick):
      // der Link steht sichtbar im Dialog, der Gastgeber markiert ihn selbst.
    }
  }

  async function entwerten(id: string) {
    if (entwertetLaeuft.has(id)) return;
    entwertetLaeuft = new Set([...entwertetLaeuft, id]);
    try {
      await revokeGastLink(id);
      await laden();
    } catch (e) {
      toast.error((e as Error).message || m.gast_fehler_allgemein());
    } finally {
      const rest = new Set(entwertetLaeuft);
      rest.delete(id);
      entwertetLaeuft = rest;
    }
  }

  function datum(iso: string): string {
    return new Date(iso).toLocaleString();
  }

  const aktiv = $derived(links.filter((l) => !l.revoked));
  const erloschen = $derived(links.filter((l) => l.revoked));
</script>

<Dialog.Root bind:open>
  <Dialog.Content class="flex max-h-[85dvh] flex-col overflow-hidden sm:max-w-lg">
    <Dialog.Header>
      <Dialog.Title>{m.gast_links_titel()}</Dialog.Title>
      <Dialog.Description>{m.gast_links_hinweis()}</Dialog.Description>
    </Dialog.Header>

    {#if frischerCode}
      <div class="space-y-2 rounded-md border p-3">
        <p class="text-muted-foreground text-xs">{m.gast_links_code_einmal()}</p>
        <div class="flex items-center gap-2">
          <code class="bg-muted min-w-0 flex-1 truncate rounded px-2 py-1 text-xs" data-testid="gast-link-url">
            {gastLinkUrl(frischerCode)}
          </code>
          <!-- ``gast_links_kopiert`` ist die Rückmeldung NACH dem Klick
               (Toast) — als Knopf-Beschriftung behauptete sie, es sei schon
               geschehen. -->
          <Button size="sm" variant="secondary" onclick={() => kopieren(frischerCode!)}>
            {m.gast_links_kopieren()}
          </Button>
        </div>
      </div>
    {/if}

    <!-- Zeitfenster der NEUEN Links. Die Vorgaben (Chips) setzen „bis";
         beide Felder bleiben frei editierbar — „ab" leer heisst ab sofort.
         Der Dialog-Body scrollt, damit Knöpfe nie über den Rahmen laufen. -->
    <div class="space-y-2">
      <div class="flex flex-wrap gap-1.5">
        {#each DAUER as preset (preset.stunden)}
          <button
            type="button"
            class="rounded-full border px-2.5 py-0.5 text-xs transition-colors {dauer === preset.stunden && !abIso
              ? 'border-primary bg-primary/10 text-primary'
              : 'border-border text-muted-foreground hover:text-text-base'}"
            onclick={() => dauerWaehlen(preset.stunden)}
          >
            {preset.label()}
          </button>
        {/each}
      </div>
      <div class="grid grid-cols-2 gap-2">
        <label class="block space-y-1">
          <span class="text-muted-foreground text-xs">{m.gast_links_gueltig_ab()}</span>
          <input
            type="datetime-local"
            bind:value={gueltigAb}
            class="border-border bg-bg-input w-full rounded-md border px-2 py-1.5 text-sm"
          />
        </label>
        <label class="block space-y-1">
          <span class="text-muted-foreground text-xs">{m.gast_links_gueltig_bis()}</span>
          <input
            type="datetime-local"
            bind:value={gueltigBis}
            class="border-border bg-bg-input w-full rounded-md border px-2 py-1.5 text-sm"
          />
        </label>
      </div>
    </div>

    <div class="min-h-0 flex-1 space-y-2 overflow-y-auto pr-1">
      {#if aktiv.length > 0}
        {#each aktiv as link (link.id)}
          <div class="flex items-center justify-between gap-3 rounded-md border px-3 py-2 text-sm">
            <span class="text-text-base truncate">
              {link.valid_from && new Date(link.valid_from) > new Date()
                ? `${m.gast_links_gueltig_ab()} ${datum(link.valid_from)} · `
                : ''}{m.gast_links_laeuft_ab({ datum: datum(link.expires_at) })}
            </span>
            <Button size="sm" variant="ghost" disabled={entwertetLaeuft.has(link.id)} onclick={() => entwerten(link.id)} data-testid="gast-link-entwerten">
              {m.gast_links_entwerten()}
            </Button>
          </div>
        {/each}
      {:else}
        <p class="text-muted-foreground py-2 text-sm">{m.gast_links_leer()}</p>
      {/if}

      {#if erloschen.length > 0}
        <!-- Eingeklappt: die Geschichte der Besprechung soll wachsen dürfen,
             ohne den aktiven Link zu erdrücken. -->
        <div class="rounded-md border border-dashed px-3 py-2">
          <button
            type="button"
            class="text-muted-foreground hover:text-text-base flex w-full items-center justify-between gap-2 text-sm"
            title={m.gast_links_erloschen_hinweis()}
            onclick={() => (erloschenOffen = !erloschenOffen)}
            data-testid="gast-links-erloschen-toggle"
          >
            <span>{m.gast_links_erloschen({ anzahl: erloschen.length })}</span>
            {#if erloschenOffen}
              <ChevronUpIcon class="size-4" />
            {:else}
              <ChevronDownIcon class="size-4" />
            {/if}
          </button>
          {#if erloschenOffen}
            <ul class="mt-2 space-y-1">
              {#each erloschen as link (link.id)}
                <li class="text-muted-foreground flex items-center justify-between gap-2 text-xs">
                  <span>
                    {link.valid_from && new Date(link.valid_from) > new Date()
                      ? `${m.gast_links_gueltig_ab()} ${datum(link.valid_from)} · `
                      : ''}{m.gast_links_laeuft_ab({ datum: datum(link.expires_at) })}
                  </span>
                  <span class="shrink-0">{m.gast_links_entwertet()}</span>
                </li>
              {/each}
            </ul>
          {/if}
        </div>
      {/if}
    </div>

    <Dialog.Footer>
      <Button onclick={erzeugen} disabled={laedt || !eingabeOk} data-testid="gast-link-erzeugen">
        {m.gast_links_erzeugen()}
      </Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
