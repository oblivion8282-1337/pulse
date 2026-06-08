<!--
  Changelog-Dialog: zeigt einen oder mehrere Release-Einträge im jeweils
  gewählten Fun-Stil. Wird NICHT selbst getriggert — der ChangelogGate
  entscheidet (Versionsvergleich), ob und mit welchen Einträgen er öffnet.
  Inhalt stammt aus der repo-eigenen static/changelog.json (kein User-Input),
  daher Plain-Text-Rendering ohne Markdown/Sanitizer.
-->
<script lang="ts">
  import * as Dialog from '$lib/components/ui/dialog/index.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import type { ChangelogEntry } from '$lib/changelog/types';

  interface Props {
    entries: ChangelogEntry[];
    open: boolean;
    onClose: () => void;
  }
  let { entries, open, onClose }: Props = $props();

  function fmtDate(iso: string): string {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    return d.toLocaleDateString('de-DE', { day: 'numeric', month: 'long', year: 'numeric' });
  }

  // Schließen über X / Overlay / Esc läuft alles über onOpenChange(false).
  function handleOpenChange(next: boolean): void {
    if (!next) onClose();
  }
</script>

<Dialog.Root {open} onOpenChange={handleOpenChange}>
  <Dialog.Content data-testid="changelog-dialog" class="max-h-[80vh] overflow-y-auto">
    <Dialog.Header>
      <Dialog.Title>Was ist neu?</Dialog.Title>
      <Dialog.Description>Frisch aktualisiert — hier die Neuigkeiten.</Dialog.Description>
    </Dialog.Header>

    <div class="space-y-6 py-2">
      {#each entries as entry (entry.id)}
        <section data-testid="changelog-entry">
          <div class="flex items-center justify-between gap-2">
            <h3 class="text-lg font-semibold leading-tight">{entry.title}</h3>
            <span
              class="shrink-0 rounded-full bg-primary/10 px-2.5 py-0.5 text-xs font-medium text-primary"
            >
              {entry.style}
            </span>
          </div>
          {#if entry.date}
            <p class="mt-0.5 text-xs text-muted-foreground">{fmtDate(entry.date)}</p>
          {/if}
          {#if entry.intro}
            <p class="mt-2 text-sm italic text-muted-foreground">{entry.intro}</p>
          {/if}
          <ul class="mt-3 space-y-1.5 text-sm">
            {#each entry.items as item}
              <li class="flex gap-2">
                <span aria-hidden="true" class="text-primary">›</span>
                <span>{item}</span>
              </li>
            {/each}
          </ul>
          {#if entry.outro}
            <p class="mt-3 text-sm font-medium">{entry.outro}</p>
          {/if}
        </section>
      {/each}
    </div>

    <Dialog.Footer>
      <Button onclick={onClose} data-testid="changelog-close">Verstanden</Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
