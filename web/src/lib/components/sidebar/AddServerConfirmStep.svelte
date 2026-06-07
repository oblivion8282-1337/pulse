<!--
  AddServerConfirmStep — Schritt 2 des AddServerDialog-Wizards.
  Zeigt Server-Info, Disclaimer und optionalen Community-Invite-Code.
  Ruft confirmAdd-Callback bei Bestätigung.
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
  import type { ServerInfo } from '$lib/api/server-info';
  import { m } from '$lib/paraglide/messages.js';

  let {
    info,
    resolvedHostname,
    inviteInput = $bindable(''),
    error,
    busy,
    onBack,
    onConfirm,
  }: {
    info: ServerInfo;
    resolvedHostname: string;
    inviteInput: string;
    error: string | null;
    busy: boolean;
    onBack: () => void;
    onConfirm: () => void;
  } = $props();

  let labelHost = $derived(resolvedHostname.replace(/^https?:\/\//, ''));
</script>

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
      {labelHost}
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
      <strong>{labelHost}</strong>
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
    <Button type="button" variant="ghost" onclick={onBack} disabled={busy}>
      {m.add_server_dialog_btn_back()}
    </Button>
    <Button onclick={onConfirm} disabled={busy} data-testid="add-server-confirm">
      {busy ? m.add_server_dialog_btn_adding() : m.add_server_dialog_btn_confirm_add()}
    </Button>
  </Dialog.Footer>
</div>
