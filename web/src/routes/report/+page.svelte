<!--
  Öffentliches Missbrauchs-Melde-Formular (ohne Login). POST /reports (auth-svc),
  3/h pro IP. Erreichbar über den Rechtliches-Footer. Deckt die gesetzliche
  Pflicht ab, rechtswidrige Inhalte melden zu können (DSA/NetzDG), und ist der
  Eingang für den Cloud-Admin-Bereich „Missbrauchsmeldungen".
-->
<script lang="ts">
  import { m } from '$lib/paraglide/messages.js';
  import { Button } from '$lib/components/ui/button';
  import { Input } from '$lib/components/ui/input/index.js';
  import { Label } from '$lib/components/ui/label/index.js';
  import FieldLabel from '$lib/components/form/FieldLabel.svelte';
  import { ApiError } from '$lib/api/client';
  import { submitAbuseReport } from '$lib/api/complaints';
  import FieldError from '$lib/components/feedback/FieldError.svelte';

  let targetUrl = $state('');
  let body = $state('');
  let email = $state('');

  let submitting = $state(false);
  let done = $state(false);
  let formError = $state<string | null>(null);

  function reset() {
    targetUrl = '';
    body = '';
    email = '';
    done = false;
    formError = null;
  }

  async function submit(e: SubmitEvent) {
    e.preventDefault();
    formError = null;

    if (!targetUrl.trim()) {
      formError = m.report_abuse_url_required();
      return;
    }
    if (body.trim().length < 10) {
      formError = m.report_abuse_body_too_short();
      return;
    }

    submitting = true;
    try {
      await submitAbuseReport({
        target_url: targetUrl.trim(),
        body: body.trim(),
        submitter_email: email.trim() || null
      });
      done = true;
    } catch (err) {
      if (err instanceof ApiError && err.status === 429) {
        formError = m.report_abuse_rate_limited();
      } else {
        formError = m.report_abuse_error_generic();
      }
    } finally {
      submitting = false;
    }
  }
</script>

<svelte:head>
  <title>{m.report_abuse_title()} · Pulse</title>
</svelte:head>

<div class="bg-background text-foreground min-h-dvh">
  <div class="mx-auto max-w-2xl px-5 py-10 sm:px-8 sm:py-14">
    <header class="mb-8 flex items-center justify-between gap-4">
      <a href="/login" class="flex items-center gap-2.5">
        <img src="/pulse-mark.svg" alt="Pulse" width="32" height="32" class="size-8" />
        <span class="text-lg font-semibold">Pulse</span>
      </a>
      <a
        href="/login"
        class="text-muted-foreground hover:text-foreground text-sm hover:underline"
      >
        {m.report_abuse_back()}
      </a>
    </header>

    <h1 class="mb-2 text-2xl font-bold tracking-tight">{m.report_abuse_title()}</h1>

    {#if done}
      <div
        class="border-border bg-muted/30 mt-6 rounded-2xl border p-6"
        data-testid="report-success"
      >
        <h2 class="mb-2 text-base font-semibold">{m.report_abuse_success_title()}</h2>
        <p class="text-muted-foreground text-sm">{m.report_abuse_success_body()}</p>
        <Button class="mt-5" onclick={reset}>
          {m.report_abuse_another()}
        </Button>
      </div>
    {:else}
      <p class="text-muted-foreground mb-6 text-sm">{m.report_abuse_intro()}</p>

      <form class="flex flex-col gap-5" onsubmit={submit} data-testid="report-form">
        <div class="flex flex-col gap-1.5">
          <FieldLabel class="text-sm font-medium" for="report-url" required>
            {m.report_abuse_url_label()}
          </FieldLabel>
          <Input
            id="report-url"
            type="text"
            bind:value={targetUrl}
            maxlength={500}
            aria-required="true"
            placeholder={m.report_abuse_url_placeholder()}
            data-testid="report-url-input"
          />
        </div>

        <div class="flex flex-col gap-1.5">
          <FieldLabel class="text-sm font-medium" for="report-body" required>
            {m.report_abuse_body_label()}
          </FieldLabel>
          <textarea
            id="report-body"
            bind:value={body}
            rows="6"
            maxlength={5000}
            aria-required="true"
            placeholder={m.report_abuse_body_placeholder()}
            data-testid="report-body-input"
            class="border-border bg-background focus:ring-primary resize-none rounded-xl border px-3 py-2 text-sm focus:ring-1 focus:outline-none"
          ></textarea>
        </div>

        <div class="flex flex-col gap-1.5">
          <Label class="text-sm font-medium" for="report-email">
            {m.report_abuse_email_label()}
          </Label>
          <Input
            id="report-email"
            type="email"
            bind:value={email}
            maxlength={320}
            placeholder={m.report_abuse_email_placeholder()}
          />
          <p class="text-muted-foreground text-xs">{m.report_abuse_email_hint()}</p>
        </div>

        <p class="text-muted-foreground border-border border-l-2 pl-3 text-xs">
          {m.report_abuse_legal_hint()}
        </p>

        <FieldError message={formError} testId="report-error" />

        <div>
          <Button type="submit" disabled={submitting} data-testid="report-submit">
            {submitting ? m.report_abuse_submitting() : m.report_abuse_submit()}
          </Button>
        </div>
      </form>
    {/if}
  </div>
</div>
