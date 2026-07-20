<!--
  Entscheidungshilfe für die Design-Vereinheitlichung — NICHT im Menü verlinkt.
  Aufruf: /app/dev/design

  Zeigt dieselben Schaltflächen in drei Spalten nebeneinander:

    1. HEUTE          — die tatsächlich im Code gefundenen Klassenketten,
                        wörtlich übernommen (Belege im Bestandsaufnahme-Dokument).
    2. ANGEPASST      — der Vorschlag, hier LOKAL als Klassenketten nachgebaut
                        (rounded-md statt rounded-full, solide destructive-Variante,
                        Verlauf als Primär).
    3. KOMPONENTE     — `lib/components/ui/button/button.svelte`, live.

  Hinweis: Die Entscheidung ist gefallen und in der Komponente umgesetzt — Spalte 2
  und 3 gleichen sich seitdem weitgehend. Spalte 1 zeigt weiter, was noch von Hand
  gebaut ist und auf die Komponente umgestellt gehört.

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
  import UsersIcon from '@lucide/svelte/icons/users';
  import CheckIcon from '@lucide/svelte/icons/check';
  import { Input } from '$lib/components/ui/input';
  import { Label } from '$lib/components/ui/label';

  // ── Spalte 2: Vorschlag "Komponente an App angepasst" ────────────────────
  // Bewusst als reine Klassenketten hier, nicht in der echten Komponente.
  const base =
    'inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-md ' +
    'border border-transparent text-sm font-medium transition-all outline-none select-none ' +
    'disabled:pointer-events-none disabled:opacity-50';
  const h = 'h-8 px-3';
  const proposed = {
    // Der Verlauf bleibt: 42 Buttons nutzen ihn, app.css weist ihn ausdrücklich
    // als Primär-Behandlung aus. Die 21 flachen rohen Primär-Buttons wandern hierher.
    primary: `${base} ${h} accent-gradient text-white shadow-[0_4px_14px_rgba(37,99,235,0.25)] hover:brightness-110`,
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
    // VoiceParticipantTile.svelte:208 — die LIVE-Marke: sieht aus wie ein
    // Gefahren-Knopf, ist aber keiner (Rot heisst hier Aufnahme, nicht Fehler).
    // Läuft seit 2026-07-20 über `--color-badge-live` und steht deshalb nur noch
    // als Gegenbeispiel in dieser Reihe.
    badgeLive:
      'cursor-pointer rounded-md bg-badge-live px-3 py-1.5 text-sm font-bold text-white shadow-sm hover:bg-badge-live-hover active:scale-95',
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
      note: '2 Ausprägungen — Token solide und getönt; die LIVE-Marke sieht nur so aus und hat seit 2026-07-20 ein eigenes Token',
      today: [
        ['solide (Token)', today.dangerSolid],
        ['getönt (Token)', today.dangerTint],
        ['LIVE-Marke (eigenes Token)', today.badgeLive]
      ],
      proposed: proposed.danger,
      shadcn: 'destructive'
    }
  ];

  // Alle Abschnitte haben dieselbe Kopfzeile und dasselbe Dreispalten-Raster.
  const cols = 'grid grid-cols-3 items-start gap-4';

  // Typografie — Zahlen aus dem Bestand.
  const H2_TODAY = [
    { area: 'Admin', cls: 'text-base font-semibold', n: 20, val: 'text-base' },
    { area: 'Einstellungen', cls: 'text-lg font-semibold', n: 14, val: 'text-lg' },
    { area: 'Rest', cls: 'text-xs font-semibold', n: 5, val: 'text-xs' },
    { area: 'Einstellungen (Ausreisser)', cls: 'text-base font-semibold', n: 4, val: 'text-base' },
    { area: 'Admin (Ausreisser)', cls: 'text-lg font-semibold', n: 2, val: 'text-lg' }
  ];
  const SCALE_PROPOSED = [
    { role: 'Dialog-/Seitentitel', cls: 'text-lg font-semibold', val: 'text-lg · 18px' },
    { role: 'Abschnitt (h2)', cls: 'text-base font-semibold', val: 'text-base · 16px' },
    { role: 'Unterabschnitt (h3)', cls: 'text-sm font-semibold', val: 'text-sm · 14px' },
    { role: 'Fliesstext', cls: 'text-sm', val: 'text-sm · 14px' },
    { role: 'Hilfetext, Meta', cls: 'text-xs text-text-muted', val: 'text-xs · 12px' },
    { role: 'Kleinstschrift (Marken, Zeitstempel)', cls: 'text-[11px] text-text-muted', val: 'text-[11px] · 11px' }
  ];

  // Formulare — wörtlich aus dem Code.
  const INPUTS_TODAY = [
    { file: 'routes/app', cls: 'border-border bg-background focus:ring-primary rounded-xl border px-3 py-2 text-sm focus:ring-1 focus:outline-none' },
    { file: 'EmojiPicker', cls: 'text-text-bright placeholder:text-text-muted w-full rounded-md border border-border bg-bg-chat px-2.5 py-1.5 text-sm outline-none focus:border-primary' },
    { file: 'QuickSwitcher', cls: 'border-border text-text-bright placeholder:text-text-muted w-full border-b bg-transparent px-4 py-3 text-sm outline-none' },
    { file: 'AdminCommunityLimits', cls: 'border-border bg-bg-input text-text-base focus:border-primary rounded-md border px-3 py-1.5 text-sm outline-none' },
    { file: 'SettingsScreenShare', cls: 'bg-bg-soft border-border-soft text-text-bright focus:border-primary w-full rounded-md border px-2 py-2 text-sm outline-none' }
  ];
  const CHECKBOXES_TODAY = [
    { n: 8, label: 'ohne jede Gestaltung', cls: '' },
    { n: 7, label: 'accent-[var(--brand)] size-5 md:size-4', cls: 'size-5 accent-[var(--brand)] md:size-4' },
    { n: 5, label: 'accent-primary size-4', cls: 'size-4 accent-primary' },
    { n: 2, label: 'nur size-4', cls: 'size-4' }
  ];

  // Menüzeilen: wörtlich aus dem Code, je Datei die abweichenden Werte.
  // 30 Fundstellen, 16 verschiedene Ausprägungen für dieselbe Sache.
  const MENU_ROWS_TODAY = [
    {
      file: 'GuildSettingsDialog',
      note: 'gap-2 · px-3 py-2 · rounded-md · sm',
      cls: 'hover:bg-bg-hover mb-1 flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm'
    },
    {
      file: 'MemberListItem',
      note: 'gap-2.5 · px-3 py-2 · rounded-xl · Grundgrösse',
      cls: 'hover:bg-bg-hover flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left transition-colors'
    },
    {
      file: 'DMChannelList',
      note: 'gap-3 · px-3 py-3 · rounded-xl · base',
      cls: 'group flex w-full items-center gap-3 rounded-xl px-3 py-3 text-left text-base font-medium transition-colors hover:bg-bg-hover'
    },
    {
      file: 'VoiceChannelMembers',
      note: 'gap-2.5 · px-2.5 py-1.5 · rounded-md · sm',
      cls: 'text-text-muted hover:bg-bg-hover flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-sm'
    },
    {
      file: 'MessageActionSheet',
      note: 'gap-3 · px-4 · min-h-12 · KEIN Radius · 15px',
      cls: 'flex min-h-12 w-full items-center gap-3 px-4 text-left text-[15px] active:bg-bg-hover'
    },
    {
      file: 'MentionAutocomplete',
      note: 'gap-2.5 · px-3 py-2 · KEIN Radius · sm',
      cls: 'flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm transition-colors hover:bg-bg-hover'
    }
  ];

  // Vorschlag: eine Zeile, drei Zustände, zwei Dichten.
  const MENU_ROW =
    'flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-left text-sm ' +
    'transition-colors hover:bg-bg-hover';

  // Radien-Staffel zur Ansicht. `surface` = Karte/Panel, `control` = Knopf darin.
  // Heute stehen beide in keinem Verhältnis: der Knopf ist härter gerundet als
  // alles um ihn herum, obwohl er das kleinste Element ist.
  const RADIUS_VARIANTS = [
    { title: 'Heute', note: 'zufällig', surface: '0.75rem', control: '0.32rem', recommended: false },
    { title: 'Vorschlag', note: '8 / 12 / 16', surface: '0.75rem', control: '0.5rem', recommended: true },
    { title: 'Weicher', note: '10 / 16 / 20', surface: '1rem', control: '0.625rem', recommended: false }
  ];
</script>

<div class="mx-auto max-w-6xl space-y-10 p-6">
  <header class="space-y-2">
    <h1 class="text-2xl font-semibold">Design-Vereinheitlichung — Vergleich</h1>
    <p class="text-text-muted max-w-3xl text-sm">
      Dieselben Schaltflächen in drei Fassungen. Spalte 2 ist der Vorschlag, die
      Button-Komponente an die App anzugleichen; Spalte 3 die Komponente, wie sie
      aktuell aussieht. Diese Seite ändert nichts an der App — sie zeigt nur.
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
    <div>3 — Komponente live</div>
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



  <section class="space-y-3 border-t border-border pt-6">
    {@render head(
      'Typografie',
      'Dieselbe Überschriftenebene ist je nach Bereich unterschiedlich gross — und zwar nicht ein bisschen: von 12px bis 18px. Dazu 88 Pixel-Angaben an der Skala vorbei.'
    )}

    <h3 class="text-text-bright pt-2 text-sm font-semibold">
      Abschnittsüberschriften (h2) — 9 Kombinationen
    </h3>
    <div class="grid grid-cols-1 gap-4 md:grid-cols-2">
      <div class="border-border rounded-md border">
        <div class="border-border text-rail border-b px-3 py-2 font-mono text-[10.5px] tracking-wider uppercase">
          Heute
        </div>
        <div class="bg-bg-chat space-y-3 p-4">
          {#each H2_TODAY as h (h.area + h.val)}
            <div class="flex items-baseline justify-between gap-3">
              <span class={h.cls}>Berechtigungen</span>
              <span class="text-text-muted shrink-0 font-mono text-[10px]">
                {h.area} · {h.val} · {h.n}x
              </span>
            </div>
          {/each}
          <p class="text-text-muted pt-1 text-xs">
            Ein <code>&lt;h2&gt;</code> bei 12px ist kleiner als der Fliesstext darunter.
          </p>
        </div>
      </div>
      <div class="border-border rounded-md border">
        <div class="border-border border-b px-3 py-2 font-mono text-[10.5px] font-bold tracking-wider uppercase">
          Vorschlag — eine Rolle, eine Grösse
        </div>
        <div class="bg-bg-chat space-y-3 p-4">
          {#each SCALE_PROPOSED as r (r.role)}
            <div class="flex items-baseline justify-between gap-3">
              <span class={r.cls}>{r.role}</span>
              <span class="text-text-muted shrink-0 font-mono text-[10px]">{r.val}</span>
            </div>
          {/each}
        </div>
      </div>
    </div>

    <h3 class="text-text-bright pt-4 text-sm font-semibold">
      Die 88 Pixel-Angaben neben der Skala
    </h3>
    <div class="border-border bg-bg-chat rounded-md border p-4">
      <div class="flex flex-wrap items-baseline gap-x-8 gap-y-3">
        <span class="text-xs">text-xs — 12px (Skala)</span>
        <span class="text-[11px]">text-[11px] — 25x</span>
        <span class="text-[10px]">text-[10px] — 53x</span>
        <span class="text-[9px]">text-[9px] — 2x</span>
        <span class="text-[0.65rem]">text-[0.65rem] — 4x</span>
      </div>
      <p class="text-text-muted pt-3 text-xs">
        Vier Ad-hoc-Stufen unterhalb der kleinsten Skalenstufe. Der Bedarf ist echt —
        Zeitstempel und Marken brauchen etwas Kleineres als 12px. Nur brauchen sie nicht
        <strong>vier</strong> verschiedene. Vorschlag: eine einzige Kleinstschrift
        (11px), die 10px und 9px schlucken.
      </p>
    </div>

    <h3 class="text-text-bright pt-4 text-sm font-semibold">Hilfetexte — 12px oder 14px?</h3>
    <div class="border-border bg-bg-chat grid grid-cols-1 gap-4 rounded-md border p-4 md:grid-cols-2">
      <div>
        <p class="text-sm">Einstellung ändern</p>
        <p class="text-text-muted text-xs">Erklärung dazu — text-xs, 119 Stellen</p>
      </div>
      <div>
        <p class="text-sm">Einstellung ändern</p>
        <p class="text-text-muted text-sm">Erklärung dazu — text-sm, 49 Stellen</p>
      </div>
      <p class="text-text-muted col-span-full text-xs">
        Bei 14px ist der Hilfetext genauso gross wie der Text, den er erklärt — die
        Rangfolge fehlt. Vorschlag: durchgehend 12px.
      </p>
    </div>
  </section>

  <section class="space-y-3 border-t border-border pt-6">
    {@render head(
      'Formulare — was fehlt',
      'Von 99 rohen Eingaben sind nur 42 überhaupt migrierbar. Für den Rest gibt es keine Komponente: 31 Kontrollkästchen, 11 Schieberegler, 6 Auswahlknöpfe, 5 Datei-Auswahlen, 4 Farbwähler. Der Baukasten hat nur Input und Label.'
    )}

    <h3 class="text-text-bright pt-2 text-sm font-semibold">
      Kontrollkästchen — 31 Stück, 11 Ausprägungen
    </h3>
    <div class="grid grid-cols-1 gap-4 md:grid-cols-2">
      <div class="border-border rounded-md border">
        <div class="border-border text-rail border-b px-3 py-2 font-mono text-[10.5px] tracking-wider uppercase">
          Heute
        </div>
        <div class="bg-bg-chat space-y-3 p-4">
          {#each CHECKBOXES_TODAY as c (c.label)}
            <label class="flex items-center gap-2.5 text-sm">
              <input type="checkbox" class={c.cls} checked />
              <span class="flex-1">{c.label}</span>
              <span class="text-text-muted font-mono text-[10px]">{c.n}x</span>
            </label>
          {/each}
          <p class="text-text-muted pt-1 text-xs">
            Die acht ohne Gestaltung sind rohe Browser-Kästchen — sie sehen auf jedem
            Betriebssystem anders aus.
          </p>
        </div>
      </div>
      <div class="border-border rounded-md border">
        <div class="border-border border-b px-3 py-2 font-mono text-[10.5px] font-bold tracking-wider uppercase">
          Vorschlag
        </div>
        <div class="bg-bg-chat space-y-3 p-4">
          <div class="flex items-center gap-2.5 text-sm">
            <span class="border-border bg-primary grid size-4 shrink-0 place-items-center rounded-[0.25rem] border">
              <CheckIcon class="size-3 text-white" />
            </span>
            <span>ausgewählt</span>
          </div>
          <div class="flex items-center gap-2.5 text-sm">
            <span class="border-border bg-bg-input grid size-4 shrink-0 place-items-center rounded-[0.25rem] border"></span>
            <span>nicht ausgewählt</span>
          </div>
          <div class="flex items-center gap-2.5 text-sm opacity-50">
            <span class="border-border bg-bg-input grid size-4 shrink-0 place-items-center rounded-[0.25rem] border"></span>
            <span>deaktiviert</span>
          </div>
          <p class="text-text-muted pt-1 text-xs">
            Eine Darstellung auf allen Plattformen, mit Fokusring und Tastaturbedienung.
          </p>
        </div>
      </div>
    </div>

    <h3 class="text-text-bright pt-4 text-sm font-semibold">
      Schalter — 6 Stück, handgebaut, keine Komponente
    </h3>
    <div class="border-border bg-bg-chat flex flex-wrap items-center gap-8 rounded-md border p-4">
      <div class="flex items-center gap-3">
        <span class="bg-primary relative h-6 w-11 rounded-full">
          <span class="absolute top-1 right-1 size-4 rounded-full bg-white"></span>
        </span>
        <span class="text-sm">an</span>
      </div>
      <div class="flex items-center gap-3">
        <span class="bg-bg-hover relative h-6 w-11 rounded-full">
          <span class="absolute top-1 left-1 size-4 rounded-full bg-white/70"></span>
        </span>
        <span class="text-sm">aus</span>
      </div>
      <p class="text-text-muted flex-1 text-xs">
        Sechsmal in fünf Dateien nachgebaut. Sieht überall gleich aus — bis jemand eine
        Kopie ändert.
      </p>
    </div>

    <h3 class="text-text-bright pt-4 text-sm font-semibold">
      Textfelder — 13 verschiedene Klassenketten
    </h3>
    <div class="grid grid-cols-1 gap-4 md:grid-cols-2">
      <div class="border-border rounded-md border">
        <div class="border-border text-rail border-b px-3 py-2 font-mono text-[10.5px] tracking-wider uppercase">
          Heute <span class="text-text-muted">5 von 13</span>
        </div>
        <div class="bg-bg-chat space-y-3 p-4">
          {#each INPUTS_TODAY as i (i.file)}
            <div>
              <input class={i.cls} placeholder="Eingabe" />
              <p class="text-text-muted pt-0.5 font-mono text-[9.5px]">{i.file}</p>
            </div>
          {/each}
        </div>
      </div>
      <div class="border-border rounded-md border">
        <div class="border-border border-b px-3 py-2 font-mono text-[10.5px] font-bold tracking-wider uppercase">
          Vorhandene Input-Komponente
        </div>
        <div class="bg-bg-chat space-y-3 p-4">
          <Input placeholder="Eingabe" />
          <Input placeholder="deaktiviert" disabled />
          <div class="space-y-1.5">
            <Label>
              Anzeigename
              <span class="text-destructive" aria-hidden="true">*</span>
            </Label>
            <Input placeholder="Pflichtfeld" />
            <FieldError message="Dieser Name ist schon vergeben." />
          </div>
          <p class="text-text-muted pt-1 text-xs">
            Der Stern ist neu: heute gibt es <strong>45 Pflichtfelder</strong> und keine
            einzige sichtbare Kennzeichnung.
          </p>
        </div>
      </div>
    </div>
  </section>

  <section class="space-y-3 border-t border-border pt-6">
    {@render head(
      'Menüzeilen — die noch fehlende Komponente',
      '30 Fundstellen, 16 verschiedene Ausprägungen für dieselbe Sache: eine klickbare Zeile mit Symbol und Text, linksbündig, volle Breite. Sie passen NICHT in die Button-Komponente, weil deren Grundlage `justify-center` erzwingt.'
    )}
    <div class="grid grid-cols-1 gap-4 md:grid-cols-2">
      <div class="border-border rounded-md border">
        <div class="border-border text-rail border-b px-3 py-2 font-mono text-[10.5px] tracking-wider uppercase">
          Heute <span class="text-text-muted">6 von 16 Ausprägungen</span>
        </div>
        <div class="bg-bg-chat space-y-1 p-3">
          {#each MENU_ROWS_TODAY as r (r.file)}
            <div>
              <button class={r.cls}>
                <UsersIcon class="size-4 shrink-0" />
                <span class="flex-1">Mitglieder</span>
              </button>
              <p class="text-text-muted px-1 pt-0.5 font-mono text-[9.5px]">
                {r.file} — {r.note}
              </p>
            </div>
          {/each}
        </div>
      </div>

      <div class="border-border rounded-md border">
        <div class="border-border border-b px-3 py-2 font-mono text-[10.5px] font-bold tracking-wider uppercase">
          Vorschlag <span class="text-text-muted">eine Zeile, drei Zustände</span>
        </div>
        <div class="bg-bg-chat space-y-1 p-3">
          <button class={MENU_ROW}>
            <UsersIcon class="size-4 shrink-0" />
            <span class="flex-1">Mitglieder</span>
          </button>
          <button class="{MENU_ROW} bg-bg-hover">
            <UsersIcon class="size-4 shrink-0" />
            <span class="flex-1">Ausgewählt</span>
          </button>
          <button class="{MENU_ROW} text-destructive hover:bg-destructive/10">
            <TrashIcon class="size-4 shrink-0" />
            <span class="flex-1">Verlassen</span>
          </button>
          <div class="border-border my-2 border-t"></div>
          <button class="{MENU_ROW} py-3 text-base">
            <UsersIcon class="size-4 shrink-0" />
            <span class="flex-1">Grosszügig (Touch)</span>
          </button>
          <p class="text-text-muted px-1 pt-2 font-mono text-[9.5px]">
            gap-2.5 · px-3 py-2 · rounded-md · sm — plus Varianten „aktiv", „Gefahr", „grosszügig"
          </p>
        </div>
      </div>
    </div>
    <p class="text-text-muted text-xs">
      Die Unterschiede oben sind nicht sichtbar gemeint — sie sind einfach so entstanden. Vier
      Symbolabstände, vier Innenabstände, drei Radien, drei Schriftgrössen. Nebeneinander sieht
      man, dass keiner davon eine Absicht hatte.
    </p>
  </section>

  <section class="space-y-3 border-t border-border pt-6">
    {@render head(
      'Radien-Staffel',
      'Passt der Knopf zur Fläche, in der er sitzt? Heute nicht: der Knopf ist mit ~5px die härteste Form der Oberfläche, obwohl er das kleinste Element ist. Dieselbe Art Fläche kommt zudem in vier Stufen vor (12px 79x, 16px 56x, 8px 46x, 5px 30x).'
    )}
    <div class={cols}>
      {#each RADIUS_VARIANTS as v (v.title)}
        <div class="border-border rounded-md border">
          <div
            class="border-border flex items-baseline gap-2 border-b px-3 py-2 font-mono text-[10.5px] tracking-wider uppercase"
            class:font-bold={v.recommended}
          >
            <span class={v.recommended ? 'text-text-bright' : 'text-text-muted'}>{v.title}</span>
            <span class="text-text-muted">{v.note}</span>
          </div>
          <div class="bg-bg-chat p-4">
            <!-- Nachbau der Beitreten-Karte: Fläche mit Knopf darin. -->
            <div
              class="border-border bg-bg-panel flex flex-col items-center gap-3 border p-5 text-center"
              style="border-radius: {v.surface}"
            >
              <div class="bg-bg-hover size-12 rounded-full"></div>
              <div>
                <p class="text-text-bright text-sm font-semibold">Beispiel-Community</p>
                <p class="text-text-muted text-xs">128 Mitglieder</p>
              </div>
              <button
                class="accent-gradient h-9 w-full px-3.5 text-sm font-semibold text-white"
                style="border-radius: {v.control}"
              >
                Beitreten
              </button>
            </div>
            <p class="text-text-muted mt-3 font-mono text-[10px]">
              Fläche {v.surface} · Knopf {v.control}
            </p>
          </div>
        </div>
      {/each}
    </div>
    <p class="text-text-muted text-xs">
      Zum Vergleich ganz nah beieinander — hier sieht man das Verhältnis am besten:
    </p>
    <div class="border-border bg-bg-chat flex flex-wrap items-end gap-6 rounded-md border p-4">
      {#each RADIUS_VARIANTS as v (v.title)}
        <div class="flex flex-col items-center gap-2">
          <div
            class="border-border bg-bg-panel grid size-24 place-items-center border"
            style="border-radius: {v.surface}"
          >
            <button
              class="accent-gradient h-8 px-3 text-xs font-semibold text-white"
              style="border-radius: {v.control}"
            >
              Beitreten
            </button>
          </div>
          <span class="text-text-muted font-mono text-[10px]">{v.title}</span>
        </div>
      {/each}
    </div>
  </section>
</div>
