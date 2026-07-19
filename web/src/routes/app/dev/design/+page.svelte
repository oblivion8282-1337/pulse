<!--
  Entscheidungshilfe für die Design-Vereinheitlichung — NICHT im Menü verlinkt.
  Aufruf: /app/dev/design

  Zeigt dieselben Schaltflächen in drei Spalten nebeneinander:

    1. HEUTE          — die tatsächlich im Code gefundenen Klassenketten,
                        wörtlich übernommen (Belege im Bestandsaufnahme-Dokument).
    2. ANGEPASST      — wie die Button-Komponente aussähe, wenn wir sie an die
                        App angleichen (rounded-md statt rounded-full, solide
                        destructive-Variante, flaches Primär).
    3. SHADCN PUR     — die Button-Komponente, wie sie heute ausgeliefert ist.

  Wichtig: Spalte 2 ist hier LOKAL nachgebaut. Diese Seite fasst
  `lib/components/ui/button/button.svelte` NICHT an — bis zur Entscheidung
  ändert sich am Aussehen der App nichts.

  Grundlage: docs/2026-07-19-design-vereinheitlichung-bestandsaufnahme.md
-->
<script lang="ts">
  import { Button, type ButtonVariant } from '$lib/components/ui/button';
  import TrashIcon from '@lucide/svelte/icons/trash-2';
  import PencilIcon from '@lucide/svelte/icons/pencil';
  import EmptyState from '$lib/components/feedback/EmptyState.svelte';
  import LoadingState from '$lib/components/feedback/LoadingState.svelte';
  import FieldError from '$lib/components/feedback/FieldError.svelte';
  import InboxIcon from '@lucide/svelte/icons/inbox';

  // ── Spalte 2: Vorschlag "Komponente an App angepasst" ────────────────────
  // Bewusst als reine Klassenketten hier, nicht in der echten Komponente.
  const base =
    'inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-md ' +
    'border border-transparent text-sm font-medium transition-all outline-none select-none ' +
    'disabled:pointer-events-none disabled:opacity-50';
  const h = 'h-8 px-3';
  const proposed = {
    primary: `${base} ${h} bg-primary text-white hover:bg-primary/90`,
    secondary: `${base} ${h} bg-secondary text-secondary-foreground hover:bg-secondary/80`,
    outline: `${base} ${h} border-border bg-card hover:bg-muted`,
    ghost: `${base} ${h} hover:bg-bg-hover`,
    danger: `${base} ${h} bg-destructive text-white hover:bg-destructive/90`,
    dangerSoft: `${base} ${h} bg-destructive/10 text-destructive hover:bg-destructive/20`,
    icon: 'inline-flex size-8 shrink-0 items-center justify-center rounded-md transition-colors hover:bg-bg-hover'
  };

  // ── Spalte 1: wörtlich aus dem Code ──────────────────────────────────────
  const today = {
    // admin/AdminStreamLimits.svelte:191
    primaryA:
      'rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-white transition-colors hover:opacity-90',
    // dropbox/DropboxMoveDialog.svelte:71
    primaryB: 'rounded-md bg-primary px-3 py-1 text-sm font-medium text-white',
    // routes/report/+page.svelte:155
    primaryC: 'bg-primary rounded-xl px-5 py-2.5 text-sm font-medium text-white hover:opacity-90',
    // account/InstanceSetupDialog.svelte:371
    primaryD: 'bg-primary hover:bg-primary/90 rounded-xl px-4 py-2 text-sm font-medium text-white',
    // admin/AdminInstancesActive.svelte:201
    cancelA: 'rounded-xl border border-border px-4 py-2 text-sm text-text-base hover:bg-bg-hover',
    // dropbox/DropboxRenameDialog.svelte:38
    cancelB: 'rounded-md px-3 py-1 text-sm hover:bg-bg-hover',
    // chat/ReportMessageDialog.svelte:208
    cancelC: 'bg-bg-input text-text-base hover:bg-bg-hover rounded-md px-4 py-2 text-sm',
    // auth/LoginMfaForm.svelte:200
    cancelD: 'text-muted-foreground hover:underline',
    // account/BootstrapConsumedPanel.svelte:26
    cancelE: 'rounded-lg border border-border px-3 py-1.5 text-xs text-text-base hover:bg-bg-hover',
    // settings/DangerZoneSection.svelte:41
    dangerSolid:
      'bg-destructive hover:bg-destructive/90 rounded-md px-3 py-2 text-sm font-medium text-white md:py-1.5',
    // settings/SessionsSection.svelte:153
    dangerTint:
      'text-destructive bg-destructive/10 hover:bg-destructive/20 rounded-md px-3 py-2 text-xs font-medium md:py-1.5',
    // VoiceParticipantTile.svelte:208 — hartkodiertes Rot statt Token
    dangerHard:
      'cursor-pointer rounded-md bg-red-600 px-3 py-1.5 text-sm font-bold text-white shadow-sm hover:bg-red-500 active:scale-95',
    // dropbox/DropboxEntryCard.svelte:101 (11x identisch im Repo)
    iconA: 'rounded p-1 hover:bg-bg-hover',
    // MessageActions.svelte:96
    iconB: 'text-text-muted hover:bg-bg-hover rounded-md p-1.5',
    // settings/PasskeyRow.svelte:157
    iconC: 'text-text-muted hover:bg-bg-hover rounded-md p-2 transition-colors md:p-1.5'
  };

  const rows: {
    title: string;
    note: string;
    /** Beschriftung + wörtliche Klassenkette je Fundstelle. */
    today: [string, string][];
    proposed: string;
    shadcn: ButtonVariant;
  }[] = [
    {
      title: 'Primär / Speichern',
      note: '4 Ausprägungen im Code — zwei Radien, zwei Textgrößen, drei Hover-Verhalten',
      today: [
        ['px-3 py-1.5 text-xs', today.primaryA],
        ['px-3 py-1 text-sm', today.primaryB],
        ['rounded-xl px-5', today.primaryC],
        ['rounded-xl px-4', today.primaryD]
      ],
      proposed: proposed.primary,
      shadcn: 'default'
    },
    {
      title: 'Abbrechen',
      note: '5 Ausprägungen — mit Rahmen, ohne, gefüllt, als Textlink, klein',
      today: [
        ['rounded-xl + Rahmen', today.cancelA],
        ['ohne Rahmen', today.cancelB],
        ['gefüllt', today.cancelC],
        ['Textlink', today.cancelD],
        ['klein + Rahmen', today.cancelE]
      ],
      proposed: proposed.outline,
      shadcn: 'outline'
    },
    {
      title: 'Löschen / Gefahr',
      note: '3 Farbquellen: Token solide, Token getönt, hartkodiertes bg-red-600',
      today: [
        ['solide (Token)', today.dangerSolid],
        ['getönt (Token)', today.dangerTint],
        ['bg-red-600 (fest)', today.dangerHard]
      ],
      proposed: proposed.danger,
      shadcn: 'destructive'
    }
  ];

  // Alle Abschnitte haben dieselbe Kopfzeile und dasselbe Dreispalten-Raster.
  const cols = 'grid grid-cols-3 items-start gap-4';
</script>

<div class="mx-auto max-w-6xl space-y-10 p-6">
  <header class="space-y-2">
    <h1 class="text-2xl font-semibold">Design-Vereinheitlichung — Vergleich</h1>
    <p class="text-text-muted max-w-3xl text-sm">
      Dieselben Schaltflächen in drei Fassungen. Spalte 2 ist der Vorschlag, die
      Button-Komponente an die App anzugleichen; Spalte 3 die Komponente, wie sie heute
      ausgeliefert wird. Diese Seite ändert nichts an der App — sie zeigt nur.
    </p>
  </header>

  {#snippet head(title: string, note: string)}
    <div>
      <h2 class="text-base font-semibold">{title}</h2>
      <p class="text-text-muted text-xs">{note}</p>
    </div>
  {/snippet}

  <div class="grid grid-cols-3 gap-4 border-b border-border pb-2 text-sm font-semibold">
    <div>1 — Heute im Code</div>
    <div>2 — Komponente angepasst</div>
    <div>3 — shadcn pur</div>
  </div>

  {#each rows as row (row.title)}
    <section class="space-y-3">
      {@render head(row.title, row.note)}
      <div class={cols}>
        <div class="flex flex-wrap items-center gap-2">
          {#each row.today as [label, cls] (label)}
            <div class="flex flex-col items-start gap-1">
              <button class={cls}>Aktion</button>
              <span class="text-text-muted text-[10px]">{label}</span>
            </div>
          {/each}
        </div>
        <div class="flex flex-wrap items-center gap-2">
          <button class={row.proposed}>Aktion</button>
        </div>
        <div class="flex flex-wrap items-center gap-2">
          <Button variant={row.shadcn} size="sm">Aktion</Button>
        </div>
      </div>
    </section>
  {/each}

  <section class="space-y-3">
    {@render head(
      'Icon-Schaltflächen',
      'Sechs Innenabstände im Code (p-1.5 21x, p-1 20x, p-2 6x, p-0.5 5x, p-2.5 4x, p-3 3x)'
    )}
    <div class={cols}>
      <div class="flex flex-wrap items-center gap-3">
        <button class={today.iconA}><PencilIcon class="size-4" /></button>
        <button class={today.iconB}><PencilIcon class="size-4" /></button>
        <button class={today.iconC}><TrashIcon class="size-4" /></button>
      </div>
      <div class="flex items-center gap-3">
        <button class={proposed.icon}><PencilIcon class="size-4" /></button>
        <button class={proposed.icon}><TrashIcon class="size-4" /></button>
      </div>
      <div class="flex items-center gap-3">
        <Button variant="ghost" size="icon-sm"><PencilIcon class="size-4" /></Button>
        <Button variant="destructive" size="icon-sm"><TrashIcon class="size-4" /></Button>
      </div>
    </div>
  </section>

  <section class="space-y-3 border-t border-border pt-6">
    {@render head(
      'Neue gemeinsame Zustands-Komponenten',
      'Ersetzen 11 Varianten für „leer", 4 für „lädt" und 3 Farben für Feldfehler'
    )}
    <div class={cols}>
      <div class="border-border rounded-md border">
        <EmptyState message="Keine Mitglieder gefunden" />
      </div>
      <div class="border-border rounded-md border">
        <LoadingState label="Wird geladen …" />
      </div>
      <div class="border-border rounded-md border p-3">
        <FieldError message="Dieser Name ist schon vergeben." />
      </div>
    </div>
    <div class="border-border grid grid-cols-2 gap-4 rounded-md border p-2">
      <EmptyState density="page" icon={InboxIcon} message="Noch keine Nachrichten" />
      <LoadingState density="page" label="Verbinde …" />
    </div>
  </section>

  <section class="space-y-3 border-t border-border pt-6">
    {@render head(
      'Neue Status-Tokens',
      'Erfolg und Warnung gab es bisher nicht als Token — daher zwei Grün- und drei Gelb-Familien von Hand gemischt. Links neu, rechts je ein Beispiel aus dem Code.'
    )}
    <div class="flex flex-wrap items-center gap-6">
      <div class="flex items-center gap-2">
        <span class="bg-success size-4 rounded-full"></span>
        <span class="text-success text-sm">success (neu)</span>
        <span class="ml-2 size-4 rounded-full bg-emerald-500"></span>
        <span class="text-text-muted text-xs">emerald-500 (heute)</span>
      </div>
      <div class="flex items-center gap-2">
        <span class="bg-warning size-4 rounded-full"></span>
        <span class="text-warning text-sm">warning (neu)</span>
        <span class="ml-2 size-4 rounded-full bg-amber-500"></span>
        <span class="text-text-muted text-xs">amber-500 (heute)</span>
      </div>
      <div class="flex items-center gap-2">
        <span class="bg-destructive size-4 rounded-full"></span>
        <span class="text-destructive text-sm">destructive (gab es)</span>
      </div>
    </div>
  </section>
</div>
