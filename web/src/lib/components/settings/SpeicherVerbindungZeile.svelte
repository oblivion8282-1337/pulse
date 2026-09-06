<script lang="ts">
  /**
   * Eine Zeile in der Speicher-Sektion: ein Anbieter, sein Zustand
   * (`lib/ablage/zustand.ts`) und — falls `brauchtHandgriff` — der Knopf,
   * der zum passenden Handgriff führt.
   *
   * **Kontingent:** wird nur gezeigt, wenn `rohwerte.freieBytes` nicht
   * `null` ist. Heute ist das bei KEINEM Anbieter der Fall — weder
   * `dropbox.ts` noch `gdrive.ts` noch `webdav.ts` rufen eine
   * Kontingent-Abfrage ab (nachgesehen am Code, nicht aus der
   * Anbieter-Doku gefolgert, Entwurf §11 Punkt 4). Die Zeile ist trotzdem
   * schon darauf vorbereitet: sobald ein Adapter `freieBytes` liefert,
   * erscheint die Zahl hier ohne weitere Änderung an dieser Datei.
   */
  import CheckCircleIcon from '@lucide/svelte/icons/check-circle';
  import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
  import HardDriveIcon from '@lucide/svelte/icons/hard-drive';
  import CircleAlertIcon from '@lucide/svelte/icons/circle-alert';
  import ArchiveIcon from '@lucide/svelte/icons/archive';
  import { Button } from '$lib/components/ui/button/index.js';
  import { anbieter as anbieterEintrag } from '$lib/ablage/anbieter.ts';
  import { stufeEin, type VerbindungsRohwerte, type VerbindungsZustand } from '$lib/ablage/zustand.ts';
  import type { AblageVerbindung } from '$lib/ablage/verbindungen.svelte.ts';
  import { formatBytes } from '$lib/utils/formatBytes';
  import { ANBIETER_IKONE } from '$lib/components/ablage/anbieterIkonen.ts';
  import { m } from '$lib/paraglide/messages.js';

  let {
    verbindung,
    rohwerte,
    onHandgriff,
    onTrennen,
    onArchivWechsel,
  }: {
    verbindung: AblageVerbindung;
    rohwerte: VerbindungsRohwerte;
    /** Öffnet den passenden Handgriff — Verbinden-Dialog (neu anmelden / Ordner neu wählen). */
    onHandgriff: () => void;
    onTrennen: () => void;
    /** Schaltet die „mein Archiv"-Markierung dieser Verbindung um (Aufgabe 2). */
    onArchivWechsel: () => void;
  } = $props();

  const zustand = $derived(stufeEin(rohwerte));
  const eintrag = $derived(anbieterEintrag(verbindung.anbieter));
  const Icon = $derived(ANBIETER_IKONE[verbindung.anbieter] ?? HardDriveIcon);

  function datum(iso: string): string {
    return new Date(iso).toLocaleDateString('de-DE', {
      day: 'numeric',
      month: 'long',
      year: 'numeric',
    });
  }

  // Lookups statt verschachtelter Ternaries (CLAUDE.md) — je Zustand genau
  // eine Zeile statt einer fünffach gestuften Bedingung.
  const ZUSTAND_TEXT: Record<VerbindungsZustand, () => string> = {
    gut: m.speicher_zustand_gut,
    'anmeldung-abgelaufen': m.speicher_zustand_anmeldung_abgelaufen,
    'laufwerk-weg': m.speicher_zustand_laufwerk_weg,
    'kein-platz': m.speicher_zustand_kein_platz,
  };
  const ZUSTAND_FARBE: Record<VerbindungsZustand, string> = {
    gut: 'text-emerald-500',
    'anmeldung-abgelaufen': 'text-destructive',
    'laufwerk-weg': 'text-destructive',
    'kein-platz': 'text-destructive',
  };
  // Nur die beiden Fälle mit einem echten In-App-Weg bekommen einen Knopf —
  // „zu wenig Platz" ist ausserhalb von Pulse zu lösen (Entwurf §6.2).
  const HANDGRIFF_LABEL: Partial<Record<VerbindungsZustand, () => string>> = {
    'anmeldung-abgelaufen': m.speicher_handgriff_neu_anmelden,
    'laufwerk-weg': m.speicher_handgriff_ordner_waehlen,
  };

  const zustandText = $derived(ZUSTAND_TEXT[zustand]());
  const zustandFarbe = $derived(ZUSTAND_FARBE[zustand]);
  const handgriffLabel = $derived(HANDGRIFF_LABEL[zustand]?.() ?? null);
</script>

<div class="flex flex-wrap items-start justify-between gap-3 rounded-lg border p-3" data-testid="speicher-zeile">
  <div class="flex min-w-0 items-start gap-3">
    <Icon class="text-text-muted mt-0.5 size-6 shrink-0" />
    <div class="min-w-0 space-y-1">
      <p class="text-sm font-medium">
        {eintrag?.name ?? verbindung.anbieter}
        <span class="text-muted-foreground">· {verbindung.name}</span>
      </p>
      <p class="flex items-center gap-1 text-xs {zustandFarbe}" data-testid="speicher-zustand">
        {#if zustand === 'gut'}
          <CheckCircleIcon class="size-3.5" />
        {:else if zustand === 'kein-platz'}
          <CircleAlertIcon class="size-3.5" />
        {:else}
          <TriangleAlertIcon class="size-3.5" />
        {/if}
        {zustandText}
      </p>
      {#if verbindung.istArchiv}
        <p class="flex items-center gap-1 text-xs font-medium text-primary" data-testid="speicher-archiv-badge">
          <ArchiveIcon class="size-3.5" />
          {m.speicher_archiv_badge()}
        </p>
      {/if}
      <p class="text-xs text-muted-foreground">
        {m.speicher_verbunden_seit({ datum: datum(verbindung.verbundenAm) })}
        ·
        {#if verbindung.zuletztGesichertAm}
          {m.speicher_zuletzt_gesichert({ datum: datum(verbindung.zuletztGesichertAm) })}
        {:else}
          {m.speicher_zuletzt_gesichert_nie()}
        {/if}
      </p>
      {#if rohwerte.freieBytes !== null}
        <p class="text-xs text-muted-foreground">
          {m.speicher_kontingent({ frei: formatBytes(rohwerte.freieBytes) })}
        </p>
      {/if}
      {#if zustand === 'kein-platz'}
        <p class="text-xs text-destructive">{m.speicher_kein_platz_hinweis()}</p>
      {/if}
    </div>
  </div>

  <div class="flex shrink-0 items-center gap-2">
    {#if handgriffLabel}
      <Button variant="outline" size="sm" onclick={onHandgriff} data-testid="speicher-handgriff">
        {handgriffLabel}
      </Button>
    {/if}
    <Button variant="ghost" size="sm" onclick={onArchivWechsel} data-testid="speicher-archiv-umschalten">
      {verbindung.istArchiv ? m.speicher_archiv_unmarkieren() : m.speicher_archiv_markieren()}
    </Button>
    <Button variant="ghost" size="sm" onclick={onTrennen} data-testid="speicher-trennen">
      {m.speicher_trennen()}
    </Button>
  </div>
</div>
