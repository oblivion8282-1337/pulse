<!--
  AddServerDialog — Phase 5.2.

  Drei-Schritt-Wizard:
    1. URL-Eingabe (https://… oder host:port)
    2. Pre-Check via /.well-known/pulse-server-info (Version, Issuer, Capabilities)
    3. Self-Host-Disclaimer + (optional) Invite-Code
  Nach „Hinzufügen": ServerEntry wird in serversStore geschrieben, Cert-Login
  läuft (POST /cert-login/{challenge,verify}), Session-Token landet in
  sessionTokens, optional Invite-Code wird gegen den neuen Server akzeptiert,
  activeServer wechselt darauf, Dialog schließt.

  Bei Cert-Login-Fail wird der ServerEntry wieder gerollbacked. Bei Invite-
  Fail bleibt der Server bestehen (User hat einen funktionierenden Account,
  nur der Invite hat nicht geklappt) — Fehler wird per Toast gezeigt.
-->
<script lang="ts">
  import * as Dialog from '$lib/components/ui/dialog/index.js';
  import * as Alert from '$lib/components/ui/alert/index.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import { Input } from '$lib/components/ui/input/index.js';
  import { Label } from '$lib/components/ui/label/index.js';
  import OctagonXIcon from '@lucide/svelte/icons/octagon-x';
  import ServerIcon from '@lucide/svelte/icons/server';
  import ShieldAlertIcon from '@lucide/svelte/icons/shield-alert';
  import { preCheckServer, type ServerInfo } from '$lib/api/server-info';
  import { activeServer } from '$lib/stores/active-server.svelte';
  import { serversStore } from '$lib/api/servers.svelte';
  import {
    addServerWithCertLogin,
    mapCertLoginReason,
    markSelfHostDisclaimerSeen,
  } from '$lib/api/add-server-flow';
  import { CertLoginError } from '$lib/api/cert-login';
  import { toast } from 'svelte-sonner';
  import { m } from '$lib/paraglide/messages.js';

  let {
    open = false,
    onClose,
  }: {
    open?: boolean;
    onClose: () => void;
  } = $props();

  type Step = 'url' | 'confirm';
  let step = $state<Step>('url');
  let urlInput = $state('');
  let inviteInput = $state('');
  let busy = $state(false);
  let error = $state<string | null>(null);
  let info = $state<ServerInfo | null>(null);
  let resolvedHostname = $state<string>('');

  function reset(): void {
    step = 'url';
    urlInput = '';
    inviteInput = '';
    busy = false;
    error = null;
    info = null;
    resolvedHostname = '';
  }

  function handleOpenChange(next: boolean): void {
    if (!next) {
      reset();
      onClose();
    }
  }

  async function runPreCheck(e: SubmitEvent): Promise<void> {
    e.preventDefault();
    if (busy) return;
    const raw = urlInput.trim();
    if (!raw) return;
    busy = true;
    error = null;
    const result = await preCheckServer(raw);
    busy = false;
    if (!result.ok) {
      error = mapPreCheckError(result.reason);
      return;
    }
    // Duplikat-Check
    if (serversStore.findByHostname(result.hostname)) {
      error = m.add_server_dialog_already_in_list();
      return;
    }
    info = result.info;
    resolvedHostname = result.hostname;
    step = 'confirm';
  }

  function mapPreCheckError(reason: string): string {
    if (reason === 'too-old')
      return m.add_server_dialog_error_too_old();
    if (reason === 'unreachable')
      return m.add_server_dialog_error_unreachable();
    if (reason === 'cors')
      return m.add_server_dialog_error_cors();
    if (reason === 'bad-url')
      return m.add_server_dialog_error_bad_url();
    return m.add_server_dialog_error_unreadable();
  }

  async function confirmAdd(): Promise<void> {
    if (!info || busy) return;
    busy = true;
    error = null;
    const labelHost = resolvedHostname.replace(/^https?:\/\//, '');
    const code = inviteInput.trim();
    try {
      const r = await addServerWithCertLogin({
        hostname: resolvedHostname,
        label: labelHost,
        instanceId: info.instance_id ?? undefined,
        inviteCode: code || undefined,
      });
      markSelfHostDisclaimerSeen(resolvedHostname, r.entry.id);
      activeServer.set(r.entry.id);
      toast.success(m.add_server_dialog_toast_added({ host: labelHost }));
      if (r.inviteError) toast.error(m.add_server_dialog_toast_invite_error({ reason: r.inviteError }));
      else if (r.invite) toast.success(m.add_server_dialog_toast_joined({ name: r.invite.guild.name }));
      reset();
      onClose();
    } catch (err) {
      error = err instanceof CertLoginError
        ? mapCertLoginReason(err.reason)
        : (err as Error).message ?? m.add_server_dialog_error_connection_failed();
    } finally {
      busy = false;
    }
  }
</script>

<Dialog.Root {open} onOpenChange={handleOpenChange}>
  <Dialog.Content data-testid="add-server-dialog">
    {#if step === 'url'}
      <Dialog.Header>
        <Dialog.Title>{m.add_server_dialog_title_add()}</Dialog.Title>
        <Dialog.Description>
          {m.add_server_dialog_description_url()}
        </Dialog.Description>
      </Dialog.Header>
      <form class="space-y-4" onsubmit={runPreCheck}>
        <div class="space-y-1.5">
          <Label
            for="add-server-url"
            class="text-muted-foreground text-xs font-semibold uppercase tracking-wide"
          >
            {m.add_server_dialog_label_url()}
          </Label>
          <Input
            id="add-server-url"
            type="text"
            bind:value={urlInput}
            required
            autocomplete="off"
            inputmode="url"
            spellcheck={false}
            placeholder="chat.firma.de"
            data-testid="add-server-url"
          />
        </div>
        {#if error}
          <Alert.Root variant="destructive" data-testid="add-server-error">
            <OctagonXIcon />
            <Alert.Description>{error}</Alert.Description>
          </Alert.Root>
        {/if}
        <Dialog.Footer>
          <Button type="button" variant="ghost" onclick={() => handleOpenChange(false)} disabled={busy}>
            {m.add_server_dialog_btn_cancel()}
          </Button>
          <Button type="submit" disabled={busy} data-testid="add-server-precheck">
            {busy ? m.add_server_dialog_btn_checking() : m.add_server_dialog_btn_next()}
          </Button>
        </Dialog.Footer>
      </form>
    {:else}
      <Dialog.Header>
        <Dialog.Title>{m.add_server_dialog_title_confirm()}</Dialog.Title>
        <Dialog.Description>
          {m.add_server_dialog_description_confirm()}
        </Dialog.Description>
      </Dialog.Header>
      <div class="space-y-4">
        <div class="border-border bg-bg-input rounded-xl border p-3 text-sm space-y-1">
          <div class="flex items-center gap-2 font-semibold text-text-bright">
            <ServerIcon class="size-4" />
            {resolvedHostname.replace(/^https?:\/\//, '')}
          </div>
          <div class="text-text-muted text-xs">
            {m.add_server_dialog_version_label()} <span class="text-text-base font-mono">{info?.server_version}</span>
            {#if info?.instance_id}
              · {m.add_server_dialog_instance_label()} <span class="font-mono">{info.instance_id}</span>
            {/if}
          </div>
          <div class="text-text-muted text-xs">
            OIDC: <span class="font-mono">{info?.pulse_oidc_issuer}</span>
          </div>
        </div>

        <Alert.Root data-testid="self-host-disclaimer-banner">
          <ShieldAlertIcon />
          <Alert.Description>
            {m.add_server_dialog_disclaimer_prefix()}
            <strong>{resolvedHostname.replace(/^https?:\/\//, '')}</strong>
            {m.add_server_dialog_disclaimer_suffix()}
          </Alert.Description>
        </Alert.Root>

        <div class="space-y-1.5">
          <Label
            for="add-server-invite"
            class="text-muted-foreground text-xs font-semibold uppercase tracking-wide"
          >
            {m.add_server_dialog_label_invite()}
          </Label>
          <Input
            id="add-server-invite"
            type="text"
            bind:value={inviteInput}
            autocomplete="off"
            placeholder={m.add_server_dialog_invite_placeholder()}
            data-testid="add-server-invite"
          />
          <p class="text-text-muted text-xs">
            {m.add_server_dialog_cert_login_hint()}
          </p>
        </div>

        {#if error}
          <Alert.Root variant="destructive" data-testid="add-server-confirm-error">
            <OctagonXIcon />
            <Alert.Description>{error}</Alert.Description>
          </Alert.Root>
        {/if}

        <Dialog.Footer>
          <Button type="button" variant="ghost" onclick={() => (step = 'url')} disabled={busy}>
            {m.add_server_dialog_btn_back()}
          </Button>
          <Button onclick={confirmAdd} disabled={busy} data-testid="add-server-confirm">
            {busy ? m.add_server_dialog_btn_adding() : m.add_server_dialog_btn_confirm_add()}
          </Button>
        </Dialog.Footer>
      </div>
    {/if}
  </Dialog.Content>
</Dialog.Root>
