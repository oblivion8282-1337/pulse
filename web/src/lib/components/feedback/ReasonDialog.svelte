<!--
  Dialog mit optionalem Freitext-Grund (Bannen, Suspendieren, Ablehnen,
  Weiterleiten …). Ersetzt sieben handgebaute Dialog-Boilerplates in den
  Admin-Komponenten — der Text bestand vorher nur aus kopierten Klassen.

  Textfrei: Titel, Labels und Knöpfe kommen als Props von den Aufrufern (deren
  m.*-Keys bzw. Inline-Text bei den Self-Host-Views ohne paraglide). Der Grund
  wird bei jedem Öffnen geleert — der Aufrufer setzt nur `open` und `busy`.

      <ReasonDialog bind:open title={...} label={...} confirmLabel={...}
                    requireReason busy={rejecting} onConfirm={doReject} />
-->
<script lang="ts">
  import type { Snippet } from 'svelte';
  import * as Dialog from '$lib/components/ui/dialog/index.js';
  import { Button, type ButtonVariant } from '$lib/components/ui/button/index.js';
  import { Label } from '$lib/components/ui/label/index.js';
  import FieldError from '$lib/components/feedback/FieldError.svelte';

  let {
    open = $bindable(false),
    title,
    description,
    label,
    placeholder,
    maxlength = 500,
    rows = 3,
    /** Confirm erst freischalten, wenn ein Grund eingetragen ist. */
    requireReason = false,
    busy = false,
    busyLabel,
    error = null,
    confirmLabel,
    cancelLabel,
    confirmVariant = 'default',
    testId,
    children,
    onConfirm
  }: {
    open?: boolean;
    title: string;
    description?: string;
    label?: string;
    placeholder?: string;
    maxlength?: number;
    rows?: number;
    requireReason?: boolean;
    busy?: boolean;
    busyLabel?: string;
    error?: string | null;
    confirmLabel: string;
    cancelLabel: string;
    confirmVariant?: ButtonVariant;
    testId?: string;
    /** Zusatzinhalt (z. B. die „kein Betreiber-E-Mail“-Warnung beim Forward). */
    children?: Snippet;
    onConfirm: (reason: string) => void;
  } = $props();

  let reason = $state('');

  // Frisches Feld bei jedem Öffnen — die Aufrufer brauchten sonst alle ihre
  // „Grund zurücksetzen“-Zeilen (vorher stand das in jedem onclick).
  $effect(() => {
    if (open) reason = '';
  });

  function submit() {
    if (busy || (requireReason && !reason.trim())) return;
    onConfirm(reason);
  }
</script>

<Dialog.Root bind:open>
  <Dialog.Portal>
    <Dialog.Overlay />
    <Dialog.Content class="max-w-md" data-testid={testId}>
      <Dialog.Header>
        <Dialog.Title>{title}</Dialog.Title>
        {#if description}
          <Dialog.Description>{description}</Dialog.Description>
        {/if}
      </Dialog.Header>
      <div class="flex flex-col gap-2">
        {@render children?.()}
        {#if label}
          <Label class="text-text-bright text-xs font-medium">{label}</Label>
        {/if}
        <!-- Die eine Textarea-Klasse statt der bisher kopierten Varianten. -->
        <textarea
          bind:value={reason}
          {rows}
          {maxlength}
          {placeholder}
          aria-label={label}
          class="bg-bg-input border-border text-text-bright resize-none rounded-xl border px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-primary"
        ></textarea>
        {#if error}
          <FieldError message={error} />
        {/if}
      </div>
      <div class="flex justify-end gap-2 pt-2">
        <Button variant="ghost" onclick={() => (open = false)}>
          {cancelLabel}
        </Button>
        <Button variant={confirmVariant} onclick={submit} disabled={busy || (requireReason && !reason.trim())}>
          {busy ? (busyLabel ?? confirmLabel) : confirmLabel}
        </Button>
      </div>
    </Dialog.Content>
  </Dialog.Portal>
</Dialog.Root>
