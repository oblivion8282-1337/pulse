<!--
  Dialog zum Melden einer Nachricht.

  Props: messageId (Ziel-Nachricht), userId (Autor), open + onClose.
  Felder: reason_code (Select) + body (Textarea, 10-5000 Z.).
  CSAM-Sonderfall: Banner mit Behörden-Hinweis.
-->
<script lang="ts">
  import * as Dialog from '$lib/components/ui/dialog/index.js';
  import * as AlertDialog from '$lib/components/ui/alert-dialog/index.js';
  import { toast } from 'svelte-sonner';
  import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
  import { createReport, type ReasonCode } from '$lib/api/moderation';

  let {
    messageId,
    userId,
    open = $bindable(false),
    onClose
  }: {
    messageId: string;
    userId: string;
    open?: boolean;
    onClose: () => void;
  } = $props();

  const REASON_LABELS: Record<ReasonCode, string> = {
    spam: 'Spam / Werbung',
    harassment: 'Belästigung / Mobbing',
    illegal: 'Illegale Inhalte',
    csam: 'Sexueller Missbrauch von Minderjährigen (CSAM)',
    other: 'Sonstiges'
  };

  let reasonCode = $state<ReasonCode>('spam');
  let body = $state('');
  let submitting = $state(false);

  const bodyLen = $derived(body.length);
  const bodyValid = $derived(bodyLen >= 10 && bodyLen <= 5000);
  const isCsam = $derived(reasonCode === 'csam');

  async function submit() {
    if (!bodyValid || submitting) return;
    submitting = true;
    try {
      await createReport({
        target_message_id: messageId,
        target_user_id: userId,
        reason_code: reasonCode,
        body
      });
      toast.success('Meldung gesendet — Mods werden das prüfen.');
      body = '';
      reasonCode = 'spam';
      onClose();
    } catch (e) {
      toast.error('Meldung fehlgeschlagen', {
        description: e instanceof Error ? e.message : String(e)
      });
    } finally {
      submitting = false;
    }
  }

  function handleOpenChange(next: boolean) {
    if (!next) onClose();
  }
</script>

<Dialog.Root bind:open onOpenChange={handleOpenChange}>
  <Dialog.Content class="max-w-md" data-testid="report-message-dialog">
    <Dialog.Header>
      <Dialog.Title>Nachricht melden</Dialog.Title>
      <Dialog.Description>
        Deine Meldung wird an die Moderatoren weitergeleitet.
      </Dialog.Description>
    </Dialog.Header>

    <div class="flex flex-col gap-4 py-2">
      <!-- Reason Code -->
      <div class="flex flex-col gap-1.5">
        <label class="text-text-base text-sm font-medium" for="report-reason">
          Grund
        </label>
        <select
          id="report-reason"
          bind:value={reasonCode}
          class="bg-bg-input border-border text-text-base focus:border-primary w-full rounded-lg border px-3 py-2 text-sm outline-none"
          data-testid="report-reason-select"
        >
          {#each Object.entries(REASON_LABELS) as [code, label] (code)}
            <option value={code}>{label}</option>
          {/each}
        </select>
      </div>

      <!-- CSAM-Sonderhinweis -->
      {#if isCsam}
        <div
          class="flex items-start gap-2 rounded-lg border border-red-500/40 bg-red-500/10 p-3"
          data-testid="report-csam-banner"
        >
          <TriangleAlertIcon class="mt-0.5 size-4 shrink-0 text-red-400" />
          <p class="text-xs text-red-400">
            <strong>Wichtig:</strong> Bei strafrechtlich relevanten Inhalten bitte
            auch direkt bei den Behörden Anzeige erstatten. Pulse leitet Reports
            an Mods weiter, ersetzt aber keine Strafanzeige.
          </p>
        </div>
      {/if}

      <!-- Body -->
      <div class="flex flex-col gap-1.5">
        <label class="text-text-base text-sm font-medium" for="report-body">
          Beschreibung
        </label>
        <textarea
          id="report-body"
          bind:value={body}
          rows="4"
          maxlength="5000"
          placeholder="Beschreibe kurz, was das Problem ist…"
          class="bg-bg-input border-border text-text-base placeholder:text-text-muted focus:border-primary w-full resize-none rounded-lg border px-3 py-2 text-sm outline-none"
          data-testid="report-body-textarea"
        ></textarea>
        <div class="flex justify-end">
          <span
            class="text-xs {bodyLen > 5000
              ? 'text-red-400'
              : 'text-text-muted'}"
            data-testid="report-body-counter"
          >
            {bodyLen} / 5000
          </span>
        </div>
      </div>
    </div>

    <Dialog.Footer>
      <button
        type="button"
        onclick={onClose}
        class="bg-bg-input text-text-base hover:bg-bg-hover rounded-md px-4 py-2 text-sm transition-colors"
        data-testid="report-cancel"
      >
        Abbrechen
      </button>
      <button
        type="button"
        onclick={submit}
        disabled={!bodyValid || submitting}
        class="accent-gradient rounded-md px-4 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
        data-testid="report-submit"
      >
        {submitting ? 'Wird gesendet…' : 'Melden'}
      </button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
