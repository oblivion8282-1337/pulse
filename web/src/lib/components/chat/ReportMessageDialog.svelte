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
  import { submitAbuseReport } from '$lib/api/complaints';
  import { auth } from '$lib/stores/auth.svelte';
  import { m } from '$lib/paraglide/messages.js';

  let {
    messageId,
    userId,
    channelId,
    kind = 'message',
    toCloud = false,
    open = $bindable(false),
    onClose
  }: {
    /** At least one target must be set. messageId+userId = message report;
     *  userId only = user report; channelId only = channel report. */
    messageId?: string;
    userId?: string;
    channelId?: string;
    kind?: 'message' | 'user' | 'channel';
    /** Direktnachricht/Sozial-Kontext: es gibt keinen Community-Moderator, der
     *  handeln könnte. Die Meldung geht dann als Beschwerde ans Betreiberteam
     *  (auth-svc /reports → Admin-Complaints), gemeldet wird der Nutzer. */
    toCloud?: boolean;
    open?: boolean;
    onClose: () => void;
  } = $props();

  const titleText = $derived(
    kind === 'user'
      ? m.report_user_title()
      : kind === 'channel'
        ? m.report_channel_title()
        : m.report_message_title()
  );

  const REASON_LABELS: Record<ReasonCode, () => string> = {
    spam: () => m.report_message_reason_spam(),
    harassment: () => m.report_message_reason_harassment(),
    illegal: () => m.report_message_reason_illegal(),
    csam: () => m.report_message_reason_csam(),
    other: () => m.report_message_reason_other()
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
      if (toCloud) {
        // Kein Community-Moderator zuständig → Beschwerde ans Betreiberteam.
        // Complaints kennen keinen reason_code + kein Nachrichten-Ziel; wir
        // melden den Nutzer und hängen Grund + Kontext an den Text an.
        await submitAbuseReport({
          target_user_id: userId,
          body: `${body}\n\n[${m.report_message_reason_label()}: ${REASON_LABELS[reasonCode]()}${
            kind === 'message' ? `, ${m.report_to_cloud_context_dm()}` : ''
          }]`,
          submitter_email: auth.user?.email ?? null
        });
      } else {
        await createReport({
          target_message_id: messageId,
          target_user_id: userId,
          target_channel_id: channelId,
          reason_code: reasonCode,
          body
        });
      }
      toast.success(m.report_message_toast_success());
      body = '';
      reasonCode = 'spam';
      onClose();
    } catch (e) {
      toast.error(m.report_message_toast_error(), {
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
      <Dialog.Title>{titleText}</Dialog.Title>
      <Dialog.Description>
        {m.report_message_description()}
      </Dialog.Description>
    </Dialog.Header>

    <div class="flex flex-col gap-4 py-2">
      {#if toCloud}
        <p
          class="text-text-muted bg-bg-input/60 rounded-lg px-3 py-2 text-xs"
          data-testid="report-cloud-hint"
        >
          {m.report_to_cloud_hint()}
        </p>
      {/if}

      <!-- Reason Code -->
      <div class="flex flex-col gap-1.5">
        <label class="text-text-base text-sm font-medium" for="report-reason">
          {m.report_message_reason_label()}
        </label>
        <select
          id="report-reason"
          bind:value={reasonCode}
          class="bg-bg-input border-border text-text-base focus:border-primary w-full rounded-lg border px-3 py-2 text-sm outline-none"
          data-testid="report-reason-select"
        >
          {#each Object.entries(REASON_LABELS) as [code, labelFn] (code)}
            <option value={code}>{labelFn()}</option>
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
            <strong>{m.report_message_csam_warning_bold()}</strong>
            {m.report_message_csam_warning_text()}
          </p>
        </div>
      {/if}

      <!-- Body -->
      <div class="flex flex-col gap-1.5">
        <label class="text-text-base text-sm font-medium" for="report-body">
          {m.report_message_body_label()}
        </label>
        <textarea
          id="report-body"
          bind:value={body}
          rows="4"
          maxlength="5000"
          placeholder={m.report_message_body_placeholder()}
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
        {m.report_message_cancel()}
      </button>
      <button
        type="button"
        onclick={submit}
        disabled={!bodyValid || submitting}
        class="accent-gradient rounded-md px-4 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
        data-testid="report-submit"
      >
        {submitting ? m.report_message_submitting() : m.report_message_submit()}
      </button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
