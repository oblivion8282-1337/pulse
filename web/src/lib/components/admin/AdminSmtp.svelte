<!--
  AdminSmtp — Provider-Dropdown + SMTP-Form + Test-Mail-Button.
  Patches ``smtp_settings`` via /admin/smtp. Save is independent of Test
  (Forgejo-Pattern); admin clicks Test to validate, Save to persist.

  Password input is tri-state on the wire: empty leaves the stored
  password untouched (placeholder advertises this), a typed value
  replaces. ``has_password`` from the GET response drives the placeholder.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { toast } from 'svelte-sonner';
  import { Button } from '$lib/components/ui/button/index.js';
  import { Input } from '$lib/components/ui/input/index.js';
  import { Label } from '$lib/components/ui/label/index.js';
  import {
    adminApi,
    type SmtpProvider,
    type SmtpSettings,
    type SmtpSettingsPatch
  } from '$lib/api/admin';
  import { SMTP_PRESETS } from '$lib/admin/smtpProviders';
  import { auth } from '$lib/stores/auth.svelte';
  import { m } from '$lib/paraglide/messages.js';
  import SaveIcon from '@lucide/svelte/icons/save';
  import MailIcon from '@lucide/svelte/icons/mail';
  import ExternalLinkIcon from '@lucide/svelte/icons/external-link';
  import CheckCircle2Icon from '@lucide/svelte/icons/check-circle-2';
  import AlertCircleIcon from '@lucide/svelte/icons/alert-circle';

  let current = $state<SmtpSettings | null>(null);
  let provider = $state<SmtpProvider>('custom');
  let host = $state('');
  let port = $state(587);
  let username = $state('');
  let password = $state('');
  let fromEmail = $state('');
  let useSsl = $state(false);

  let loadError = $state<string | null>(null);
  let saving = $state(false);
  let testing = $state(false);
  let lastTestOk = $state<boolean | null>(null);
  let lastTestError = $state<string | null>(null);
  // Editable test-recipient: defaults to the admin's account email, but the
  // admin can override (the account email may be a placeholder on dev/test
  // accounts; showing the value also makes it obvious WHERE the test goes
  // before they click).
  let testTo = $state('');

  onMount(async () => {
    try {
      hydrate(await adminApi.getSmtpSettings());
    } catch (e) {
      loadError = e instanceof Error ? e.message : String(e);
    }
    testTo = auth.user?.email ?? '';
  });

  function hydrate(s: SmtpSettings) {
    current = s;
    provider = s.provider;
    host = s.host ?? '';
    port = s.port;
    username = s.username ?? '';
    password = ''; // never echo — empty = "preserve" on next save
    fromEmail = s.from_email ?? '';
    useSsl = s.use_ssl;
  }

  // When the admin picks a non-custom preset, fill host/port/use_ssl from
  // the preset (but leave the creds they may have already typed).
  function applyPreset(next: SmtpProvider) {
    const p = SMTP_PRESETS[next];
    if (next !== 'custom') {
      host = p.host;
      port = p.port;
      useSsl = p.use_ssl;
    }
  }

  const preset = $derived(SMTP_PRESETS[provider]);
  const lockedFields = $derived(provider !== 'custom');

  const dirty = $derived.by(() => {
    if (current === null) return false;
    return (
      provider !== current.provider ||
      host !== (current.host ?? '') ||
      port !== current.port ||
      username !== (current.username ?? '') ||
      password !== '' ||
      fromEmail !== (current.from_email ?? '') ||
      useSsl !== current.use_ssl
    );
  });

  function buildPatch(): SmtpSettingsPatch {
    return {
      provider,
      host: host || null,
      port,
      username: username || null,
      password: password ? password : undefined,
      from_email: fromEmail || null,
      use_ssl: useSsl
    };
  }

  async function save() {
    if (!dirty || saving) return;
    saving = true;
    try {
      hydrate(await adminApi.patchSmtpSettings(buildPatch()));
      toast.success(m.admin_smtp_save_success());
    } catch (e) {
      toast.error(m.admin_smtp_save_failed(), {
        description: e instanceof Error ? e.message : String(e)
      });
    } finally {
      saving = false;
    }
  }

  async function test() {
    if (testing) return;
    const to = testTo.trim();
    if (!to) {
      toast.error(m.admin_smtp_test_recipient_missing());
      return;
    }
    testing = true;
    lastTestError = null;
    try {
      const res = await adminApi.testSmtp({
        to,
        provider,
        host: host || null,
        port,
        username: username || null,
        password: password ? password : undefined,
        from_email: fromEmail || null,
        use_ssl: useSsl
      });
      lastTestOk = res.ok;
      lastTestError = res.error;
      if (res.ok) toast.success(m.admin_smtp_test_sent({ to }));
      else toast.error(m.admin_smtp_test_failed(), { description: res.error ?? '' });
    } catch (e) {
      lastTestOk = false;
      lastTestError = e instanceof Error ? e.message : String(e);
      toast.error(m.admin_smtp_test_failed(), { description: lastTestError });
    } finally {
      testing = false;
    }
  }
</script>

<section class="bg-bg-input border-border rounded-2xl border p-5" data-testid="admin-smtp">
  <div class="mb-4 flex items-start justify-between gap-3">
    <div>
      <h2 class="text-text-bright text-base font-semibold">{m.admin_smtp_heading()}</h2>
      <p class="text-text-muted mt-0.5 text-xs">
        {m.admin_smtp_description()}
      </p>
    </div>
    {#if current?.configured}
      <span
        class="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 text-xs text-emerald-400"
        data-testid="smtp-status-configured"
      >
        <CheckCircle2Icon class="size-3" /> {m.admin_smtp_status_active()}
      </span>
    {:else if current}
      <span
        class="bg-bg-hover text-text-muted inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs"
        data-testid="smtp-status-inactive"
      >
        <AlertCircleIcon class="size-3" /> {m.admin_smtp_status_not_configured()}
      </span>
    {/if}
  </div>

  {#if loadError}
    <p class="text-sm text-red-400">{m.admin_smtp_load_error({ error: loadError })}</p>
  {:else if current === null}
    <div class="text-text-muted text-sm">{m.admin_smtp_loading()}</div>
  {:else}
    <div class="flex flex-col gap-3">
      <div class="flex flex-col gap-1.5">
        <Label for="smtp-provider">Provider</Label>
        <select
          id="smtp-provider"
          class="border-border bg-bg-panel text-text-bright focus:border-primary rounded-md border px-3 py-2 text-sm outline-none"
          bind:value={provider}
          onchange={() => applyPreset(provider)}
          data-testid="smtp-provider"
        >
          {#each Object.entries(SMTP_PRESETS) as [k, p] (k)}
            <option value={k}>{p.name}</option>
          {/each}
        </select>
        {#if preset.credentials_hint}
          <p class="text-text-muted text-xs">{preset.credentials_hint}</p>
        {/if}
        {#if preset.signup_url}
          <a
            href={preset.signup_url}
            target="_blank"
            rel="noopener noreferrer"
            class="text-primary inline-flex items-center gap-1 text-xs hover:underline"
          >
            <ExternalLinkIcon class="size-3" /> {m.admin_smtp_open_provider_settings()}
          </a>
        {/if}
      </div>

      <div class="grid grid-cols-2 gap-3">
        <div class="flex flex-col gap-1.5">
          <Label for="smtp-host">Host</Label>
          <Input id="smtp-host" type="text" bind:value={host} disabled={lockedFields}
            placeholder="smtp.example.com" data-testid="smtp-host" />
        </div>
        <div class="flex flex-col gap-1.5">
          <Label for="smtp-port">Port</Label>
          <Input id="smtp-port" type="number" bind:value={port} disabled={lockedFields}
            min={1} max={65535} data-testid="smtp-port" />
        </div>
      </div>

      <label class="text-text-base flex cursor-pointer items-center gap-2 text-sm {lockedFields ? 'opacity-60' : ''}">
        <input type="checkbox" bind:checked={useSsl} disabled={lockedFields}
          class="accent-primary" data-testid="smtp-ssl" />
        {m.admin_smtp_ssl_label()}
      </label>

      <div class="grid grid-cols-2 gap-3">
        <div class="flex flex-col gap-1.5">
          <Label for="smtp-user">Login</Label>
          <Input id="smtp-user" type="text" bind:value={username}
            placeholder="user@example.com" autocomplete="off" data-testid="smtp-user" />
        </div>
        <div class="flex flex-col gap-1.5">
          <Label for="smtp-pass">{m.admin_smtp_label_password()}</Label>
          <Input id="smtp-pass" type="password" bind:value={password}
            placeholder={current.has_password ? m.admin_smtp_password_placeholder() : ''}
            autocomplete="new-password" data-testid="smtp-pass" />
        </div>
      </div>

      <div class="flex flex-col gap-1.5">
        <Label for="smtp-from">{m.admin_smtp_label_from()}</Label>
        <Input id="smtp-from" type="email" bind:value={fromEmail}
          placeholder={m.admin_smtp_from_placeholder()} data-testid="smtp-from" />
        {#if preset.from_hint}
          <p class="text-text-muted text-xs">{preset.from_hint}</p>
        {/if}
      </div>

      <div class="border-border/50 mt-2 flex flex-col gap-1.5 border-t pt-3">
        <Label for="smtp-test-to">{m.admin_smtp_label_test_to()}</Label>
        <Input
          id="smtp-test-to"
          type="email"
          bind:value={testTo}
          placeholder="admin@example.com"
          data-testid="smtp-test-to"
        />
        <p class="text-text-muted text-xs">
          {m.admin_smtp_test_to_hint()}
        </p>
      </div>

      {#if lastTestOk !== null}
        <div
          class="rounded-md border px-3 py-2 text-xs {lastTestOk
            ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
            : 'border-red-500/30 bg-red-500/10 text-red-300'}"
          data-testid="smtp-test-result"
        >
          {#if lastTestOk}
            ✓ {m.admin_smtp_test_result_ok({ to: testTo })}
          {:else}
            ✗ {lastTestError ?? m.admin_smtp_test_result_failed()}
          {/if}
        </div>
      {/if}

      <div class="mt-2 flex items-center justify-between gap-2">
        <Button variant="outline" onclick={test} disabled={testing} data-testid="smtp-test">
          <MailIcon class="size-4" />
          {testing ? m.admin_smtp_btn_sending() : m.admin_smtp_btn_send_test()}
        </Button>
        <Button onclick={save} disabled={!dirty || saving} data-testid="smtp-save">
          <SaveIcon class="size-4" />
          {saving ? m.admin_smtp_btn_saving() : m.admin_smtp_btn_save()}
        </Button>
      </div>
    </div>
  {/if}
</section>
