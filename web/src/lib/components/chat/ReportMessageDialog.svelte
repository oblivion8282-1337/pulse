<!--
  Dialog zum Melden einer Nachricht.

  Props: messageId (Ziel-Nachricht), userId (Autor), open + onClose.
  Felder: reason_code (Select) + body (Textarea, 10-5000 Z.).
  CSAM-Sonderfall: Banner mit Behörden-Hinweis.
-->
<script lang="ts">
  import * as Dialog from '$lib/components/ui/dialog/index.js';
  import { Button } from '$lib/components/ui/button';
  import * as AlertDialog from '$lib/components/ui/alert-dialog/index.js';
  import { toast } from 'svelte-sonner';
  import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
  import { createReport, createOperatorReport, type ReasonCode } from '$lib/api/moderation';
  import { submitAbuseReport } from '$lib/api/complaints';
  import { auth } from '$lib/stores/auth.svelte';
  import { m } from '$lib/paraglide/messages.js';
  import Select from '$lib/components/form/Select.svelte';

  let {
    messageId,
    userId,
    channelId,
    guildId,
    kind = 'message',
    toCloud = false,
    /** E2E-verschluesselte Nachricht: es gibt keine Nachrichten-Zeile zum
     *  Melden, nur den Nutzer (Bughunt 2026-08-28, Befund 2). Zeigt eine
     *  ehrliche Erklaerung statt eines Knopfs, der in einen 404 laeuft. */
    verschluesseltHinweis = false,
    open = $bindable(false),
    onClose
  }: {
    /** At least one target must be set. messageId+userId = message report;
     *  userId only = user report; channelId only = channel report. */
    messageId?: string;
    userId?: string;
    channelId?: string;
    /** Community a user report was raised in — pins it to that community
     *  instead of fanning out to every guild the target belongs to. */
    guildId?: string;
    kind?: 'message' | 'user' | 'channel';
    /** Direktnachricht/Sozial-Kontext: es gibt keinen Community-Moderator, der
     *  handeln könnte. Die Meldung geht dann als Beschwerde ans Betreiberteam
     *  (auth-svc /reports → Admin-Complaints), gemeldet wird der Nutzer. */
    toCloud?: boolean;
    verschluesseltHinweis?: boolean;
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

  const grundOptionen = $derived(
    (Object.entries(REASON_LABELS) as [ReasonCode, () => string][]).map(
      ([code, labelFn]) => ({ value: code, label: labelFn() }),
    ),
  );

  const bodyLen = $derived(body.length);
  // Der Freitext ist optional — die Kategorie (reason_code) ist Pflicht und
  // trägt das Wesentliche. Nur die Obergrenze wird erzwungen.
  const bodyValid = $derived(bodyLen <= 5000);
  const isCsam = $derived(reasonCode === 'csam');

  async function submit() {
    if (!bodyValid || submitting) return;
    submitting = true;
    try {
      if (toCloud && messageId) {
        // Gemeldete Direktnachricht → chat-gateway schnappschottet den
        // Nachrichten-Text serverseitig (fälschungssicher) und legt die
        // Betreiber-Beschwerde an; Bilder werden bewusst nicht übernommen.
        await createOperatorReport({
          target_message_id: messageId,
          reason_code: reasonCode,
          body
        });
      } else if (toCloud) {
        // Nutzer-Meldung ohne konkrete Nachricht (z.B. aus dem Profil) → es
        // gibt keinen Nachrichten-Snapshot; wir melden den Nutzer mit Grund.
        const context = `[${m.report_message_reason_label()}: ${REASON_LABELS[reasonCode]()}]`;
        await submitAbuseReport({
          target_user_id: userId,
          body: body ? `${body}\n\n${context}` : context,
          submitter_email: auth.user?.email ?? null
          // Melder-ID NICHT hier mitsenden — der Server leitet sie aus dem
          // Auth-Token ab (Schutz vor gefälschtem Absender / DM-Injection).
        });
      } else {
        await createReport({
          target_message_id: messageId,
          target_user_id: userId,
          target_channel_id: channelId,
          target_guild_id: guildId,
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
          class="text-text-muted bg-bg-input/60 rounded-md px-3 py-2 text-xs"
          data-testid="report-cloud-hint"
        >
          {m.report_to_cloud_hint()}
        </p>
      {/if}

      {#if verschluesseltHinweis}
        <p
          class="text-text-muted bg-bg-input/60 rounded-md px-3 py-2 text-xs"
          data-testid="report-encrypted-hint"
        >
          {m.report_message_encrypted_hint()}
        </p>
      {/if}

      <!-- Reason Code -->
      <div class="flex flex-col gap-1.5">
        <label class="text-text-base text-sm font-medium" for="report-reason">
          {m.report_message_reason_label()}
        </label>
        <Select
          id="report-reason"
          value={reasonCode}
          options={grundOptionen}
          onchange={(v) => (reasonCode = v as ReasonCode)}
          data-testid="report-reason-select"
        />
      </div>

      <!-- CSAM-Sonderhinweis -->
      {#if isCsam}
        <div
          class="flex items-start gap-2 rounded-xl border border-destructive/40 bg-destructive/10 p-3"
          data-testid="report-csam-banner"
        >
          <TriangleAlertIcon class="mt-0.5 size-4 shrink-0 text-destructive" />
          <p class="text-xs text-destructive">
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
          class="bg-bg-input border-border text-text-base placeholder:text-text-muted focus:border-primary w-full resize-none rounded-md border px-3 py-2 text-sm outline-none"
          data-testid="report-body-textarea"
        ></textarea>
        <div class="flex justify-end">
          <span
            class="text-xs {bodyLen > 5000
              ? 'text-destructive'
              : 'text-text-muted'}"
            data-testid="report-body-counter"
          >
            {bodyLen} / 5000
          </span>
        </div>
      </div>
    </div>

    <Dialog.Footer>
      <Button variant="ghost" onclick={onClose} data-testid="report-cancel">
        {m.report_message_cancel()}
      </Button>
      <Button
        onclick={submit}
        disabled={!bodyValid || submitting}
        data-testid="report-submit"
      >
        {submitting ? m.report_message_submitting() : m.report_message_submit()}
      </Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
