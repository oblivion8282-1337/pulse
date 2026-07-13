<!--
  Universal-Beitrittsfeld (Join-Modus des CreateGuildDialog) — versteht
  Einladungslinks, öffentliche Adressen (/c/<handle>), bare Codes UND nackte
  Hostadressen (ersetzt den früheren AddServerDialog):

  Hostadresse → Pre-Check → Erstkontakt-Bestätigung → Cert-Login OHNE Grant.
  Antwortet der Server mit "verlangt Einladung" (join_not_permitted), wird ein
  Code-Feld eingeblendet und der Versuch mit Code wiederholt. Ein gesperrter
  Server (join_locked) bekommt seine eigene Meldung.
-->
<script lang="ts">
  import * as Dialog from '$lib/components/ui/dialog/index.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import { Input } from '$lib/components/ui/input/index.js';
  import { Label } from '$lib/components/ui/label/index.js';
  import * as Alert from '$lib/components/ui/alert/index.js';
  import OctagonXIcon from '@lucide/svelte/icons/octagon-x';
  import SelfHostContactConfirmDialog from '$lib/components/server/SelfHostContactConfirmDialog.svelte';
  import {
    SelfHostContactConfirmRequired,
    mapCertLoginReason,
  } from '$lib/api/add-server-flow';
  import { CertLoginError } from '$lib/api/cert-login';
  import { parseJoinInput } from '$lib/guilds/joinByInvite';
  import { prepareHostJoin, joinServerByHost } from '$lib/guilds/joinByHost';
  import { m } from '$lib/paraglide/messages.js';

  let {
    onJoin,
    onBack,
  }: {
    /** Invite-/Public-Handle-Pfad — delegiert an joinGuildByInvite der Seite. */
    onJoin: (linkOrCode: string, confirmed?: boolean) => void | Promise<void>;
    onBack: () => void;
  } = $props();

  let input = $state('');
  let codeInput = $state('');
  let busy = $state(false);
  let error = $state<string | null>(null);
  // Host-Flow: nach erfolgreichem Pre-Check gemerkt, damit Retries (Erstkontakt
  // bestätigt / Code nachgereicht) nicht erneut prüfen.
  let pendingHost = $state<string | null>(null);
  // Der Server verlangt eine Einladung → Code-Feld einblenden.
  let needCode = $state(false);

  // Erstkontakt-Bestätigung (beide Pfade: Invite mit ?host= UND Hostadresse).
  let confirmOpen = $state(false);
  let confirmHost = $state('');
  let pendingAction = $state<(() => void) | null>(null);

  async function runInviteJoin(value: string, confirmed: boolean) {
    busy = true;
    error = null;
    let succeeded = false;
    try {
      await onJoin(value, confirmed);
      succeeded = true; // Parent navigiert, der Dialog unmountet.
    } catch (err) {
      if (err instanceof SelfHostContactConfirmRequired) {
        askContact(err.hostname, () => void runInviteJoin(value, true));
        return;
      }
      error =
        (err as { status?: number })?.status === 404
          ? m.create_guild_dialog_invite_invalid()
          : (err as Error)?.message || m.create_guild_dialog_join_failed();
    } finally {
      if (!succeeded) busy = false;
    }
  }

  async function runHostJoin(confirmed: boolean) {
    busy = true;
    error = null;
    let succeeded = false;
    try {
      if (!pendingHost) {
        const prep = await prepareHostJoin(input.trim());
        if (!prep.ok) {
          error = prep.message;
          return;
        }
        pendingHost = prep.hostname;
      }
      await joinServerByHost(pendingHost, codeInput.trim() || undefined, confirmed);
      succeeded = true; // navigiert weg, Dialog unmountet
    } catch (err) {
      if (err instanceof SelfHostContactConfirmRequired) {
        askContact(err.hostname, () => void runHostJoin(true));
        return;
      }
      if (err instanceof CertLoginError && err.reason === 'join-requires-invite') {
        // Kein Grant: Server verlangt eine Einladung → Code-Feld zeigen.
        needCode = true;
        error = codeInput.trim()
          ? m.join_host_code_rejected()
          : m.join_host_invite_required();
      } else if (err instanceof CertLoginError) {
        error = mapCertLoginReason(err.reason);
      } else {
        error = (err as Error)?.message || m.create_guild_dialog_join_failed();
      }
    } finally {
      if (!succeeded) busy = false;
    }
  }

  function askContact(hostname: string, retry: () => void) {
    confirmHost = hostname;
    pendingAction = retry;
    confirmOpen = true;
  }

  function onConfirmContact() {
    const action = pendingAction;
    confirmOpen = false;
    pendingAction = null;
    action?.();
  }

  function onCancelContact() {
    confirmOpen = false;
    pendingAction = null;
    busy = false;
  }

  function submit(e: SubmitEvent) {
    e.preventDefault();
    const trimmed = input.trim();
    if (!trimmed || busy) return;
    const parsed = parseJoinInput(trimmed);
    if (parsed.kind === 'host') {
      void runHostJoin(false);
    } else {
      void runInviteJoin(trimmed, false);
    }
  }

  // Eingabe geändert → Host-Flow-Zustand verwerfen (evtl. ganz anderes Ziel).
  function onInputChange() {
    pendingHost = null;
    needCode = false;
    codeInput = '';
    error = null;
  }

  const fieldLabelClass = 'text-muted-foreground text-xs font-semibold uppercase tracking-wide';
</script>

<Dialog.Header>
  <Dialog.Title>{m.create_guild_dialog_join_modal_title()}</Dialog.Title>
  <Dialog.Description>{m.create_guild_dialog_join_description()}</Dialog.Description>
</Dialog.Header>
<form class="space-y-4" onsubmit={submit}>
  <div class="space-y-1.5">
    <Label for="join-guild-input" class={fieldLabelClass}>
      {m.create_guild_dialog_invite_label()}
    </Label>
    <Input
      id="join-guild-input"
      type="text"
      bind:value={input}
      oninput={onInputChange}
      required
      autocomplete="off"
      placeholder={m.create_guild_dialog_invite_placeholder()}
      data-testid="join-guild-input"
    />
  </div>

  {#if needCode}
    <div class="space-y-1.5" data-testid="join-guild-code-block">
      <Label for="join-guild-code" class={fieldLabelClass}>
        {m.join_host_code_label()}
      </Label>
      <Input
        id="join-guild-code"
        type="text"
        bind:value={codeInput}
        autocomplete="off"
        placeholder={m.join_host_code_placeholder()}
        data-testid="join-guild-code"
      />
    </div>
  {/if}

  {#if error}
    <Alert.Root variant="destructive" data-testid="join-guild-error">
      <OctagonXIcon />
      <Alert.Description>{error}</Alert.Description>
    </Alert.Root>
  {/if}

  <Dialog.Footer>
    <Button type="button" variant="ghost" onclick={onBack} disabled={busy}>
      {m.create_guild_dialog_back()}
    </Button>
    <Button
      type="submit"
      disabled={busy || (needCode && !codeInput.trim())}
      data-testid="join-guild-submit"
    >
      {busy ? m.create_guild_dialog_joining() : m.create_guild_dialog_join_submit()}
    </Button>
  </Dialog.Footer>
</form>

<SelfHostContactConfirmDialog
  open={confirmOpen}
  hostname={confirmHost}
  onConfirm={onConfirmContact}
  onCancel={onCancelContact}
/>
