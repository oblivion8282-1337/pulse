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

  onMount(async () => {
    try {
      hydrate(await adminApi.getSmtpSettings());
    } catch (e) {
      loadError = e instanceof Error ? e.message : String(e);
    }
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
      toast.success('SMTP-Config gespeichert');
    } catch (e) {
      toast.error('Speichern fehlgeschlagen', {
        description: e instanceof Error ? e.message : String(e)
      });
    } finally {
      saving = false;
    }
  }

  async function test() {
    if (testing) return;
    if (!auth.user?.email) {
      toast.error('Keine Admin-Mail-Adresse hinterlegt');
      return;
    }
    testing = true;
    lastTestError = null;
    try {
      const res = await adminApi.testSmtp({
        to: auth.user.email,
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
      if (res.ok) toast.success(`Test-Mail an ${auth.user.email} geschickt`);
      else toast.error('Test fehlgeschlagen', { description: res.error ?? '' });
    } catch (e) {
      lastTestOk = false;
      lastTestError = e instanceof Error ? e.message : String(e);
      toast.error('Test fehlgeschlagen', { description: lastTestError });
    } finally {
      testing = false;
    }
  }
</script>

<section class="bg-bg-input border-border rounded-2xl border p-5" data-testid="admin-smtp">
  <div class="mb-4 flex items-start justify-between gap-3">
    <div>
      <h2 class="text-text-bright text-base font-semibold">Email-Versand (SMTP)</h2>
      <p class="text-text-muted mt-0.5 text-xs">
        Pulse verschickt Passwort-Reset- und Verify-Mails nur, wenn hier ein Provider eingerichtet ist.
      </p>
    </div>
    {#if current?.configured}
      <span
        class="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 text-xs text-emerald-400"
        data-testid="smtp-status-configured"
      >
        <CheckCircle2Icon class="size-3" /> Aktiv
      </span>
    {:else if current}
      <span
        class="bg-bg-hover text-text-muted inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs"
        data-testid="smtp-status-inactive"
      >
        <AlertCircleIcon class="size-3" /> Nicht eingerichtet
      </span>
    {/if}
  </div>

  {#if loadError}
    <p class="text-sm text-red-400">Fehler: {loadError}</p>
  {:else if current === null}
    <div class="text-text-muted text-sm">lade…</div>
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
            <ExternalLinkIcon class="size-3" /> Provider-Settings öffnen
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
        Implizites TLS (Port 465). Ohne Häkchen: STARTTLS (Port 587).
      </label>

      <div class="grid grid-cols-2 gap-3">
        <div class="flex flex-col gap-1.5">
          <Label for="smtp-user">Login</Label>
          <Input id="smtp-user" type="text" bind:value={username}
            placeholder="user@example.com" autocomplete="off" data-testid="smtp-user" />
        </div>
        <div class="flex flex-col gap-1.5">
          <Label for="smtp-pass">Passwort / API-Key</Label>
          <Input id="smtp-pass" type="password" bind:value={password}
            placeholder={current.has_password ? '••••••••  (leer = behalten)' : ''}
            autocomplete="new-password" data-testid="smtp-pass" />
        </div>
      </div>

      <div class="flex flex-col gap-1.5">
        <Label for="smtp-from">Absender-Adresse (From:)</Label>
        <Input id="smtp-from" type="email" bind:value={fromEmail}
          placeholder="noreply@deine-domain.de" data-testid="smtp-from" />
        {#if preset.from_hint}
          <p class="text-text-muted text-xs">{preset.from_hint}</p>
        {/if}
      </div>

      {#if lastTestOk !== null}
        <div
          class="rounded-md border px-3 py-2 text-xs {lastTestOk
            ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
            : 'border-red-500/30 bg-red-500/10 text-red-300'}"
          data-testid="smtp-test-result"
        >
          {#if lastTestOk}
            ✓ Test-Mail erfolgreich an {auth.user?.email} geschickt.
          {:else}
            ✗ {lastTestError ?? 'Test fehlgeschlagen.'}
          {/if}
        </div>
      {/if}

      <div class="mt-2 flex items-center justify-between gap-2">
        <Button variant="outline" onclick={test} disabled={testing} data-testid="smtp-test">
          <MailIcon class="size-4" />
          {testing ? 'Sende…' : 'Test-Mail an mich'}
        </Button>
        <Button onclick={save} disabled={!dirty || saving} data-testid="smtp-save">
          <SaveIcon class="size-4" />
          {saving ? 'Speichere…' : 'Speichern'}
        </Button>
      </div>
    </div>
  {/if}
</section>
