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
      error = 'Dieser Server ist bereits in deiner Liste.';
      return;
    }
    info = result.info;
    resolvedHostname = result.hostname;
    step = 'confirm';
  }

  function mapPreCheckError(reason: string): string {
    if (reason === 'too-old')
      return 'Server-Update läuft vermutlich, in ein paar Minuten erneut versuchen.';
    if (reason === 'unreachable')
      return 'Server nicht erreichbar — URL prüfen oder VPN?';
    if (reason === 'cors')
      return 'Server blockt Cross-Origin-Verbindungen. Admin muss CORS einrichten.';
    return 'Server-Antwort konnte nicht gelesen werden.';
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
      toast.success(`${labelHost} hinzugefügt`);
      if (r.inviteError) toast.error(`Invite-Code: ${r.inviteError}`);
      else if (r.invite) toast.success(`Server „${r.invite.guild.name}" beigetreten`);
      reset();
      onClose();
    } catch (err) {
      error = err instanceof CertLoginError
        ? mapCertLoginReason(err.reason)
        : (err as Error).message ?? 'Verbindung fehlgeschlagen.';
    } finally {
      busy = false;
    }
  }
</script>

<Dialog.Root {open} onOpenChange={handleOpenChange}>
  <Dialog.Content data-testid="add-server-dialog">
    {#if step === 'url'}
      <Dialog.Header>
        <Dialog.Title>Server hinzufügen</Dialog.Title>
        <Dialog.Description>
          Verbinde dich mit einem Self-Host-Server. Gib die volle URL ein —
          dein Browser ruft kurz die Server-Info ab.
        </Dialog.Description>
      </Dialog.Header>
      <form class="space-y-4" onsubmit={runPreCheck}>
        <div class="space-y-1.5">
          <Label
            for="add-server-url"
            class="text-muted-foreground text-xs font-semibold uppercase tracking-wide"
          >
            Server-URL
          </Label>
          <Input
            id="add-server-url"
            type="url"
            bind:value={urlInput}
            required
            autocomplete="off"
            placeholder="https://chat.firma.de"
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
            Abbrechen
          </Button>
          <Button type="submit" disabled={busy} data-testid="add-server-precheck">
            {busy ? 'Prüfe…' : 'Weiter'}
          </Button>
        </Dialog.Footer>
      </form>
    {:else}
      <Dialog.Header>
        <Dialog.Title>Server bestätigen</Dialog.Title>
        <Dialog.Description>
          Diese Instanz wird zu deiner Server-Liste hinzugefügt.
        </Dialog.Description>
      </Dialog.Header>
      <div class="space-y-4">
        <div class="border-border bg-bg-input rounded-xl border p-3 text-sm space-y-1">
          <div class="flex items-center gap-2 font-semibold text-text-bright">
            <ServerIcon class="size-4" />
            {resolvedHostname.replace(/^https?:\/\//, '')}
          </div>
          <div class="text-text-muted text-xs">
            Version <span class="text-text-base font-mono">{info?.server_version}</span>
            {#if info?.instance_id}
              · Instance <span class="font-mono">{info.instance_id}</span>
            {/if}
          </div>
          <div class="text-text-muted text-xs">
            OIDC: <span class="font-mono">{info?.pulse_oidc_issuer}</span>
          </div>
        </div>

        <Alert.Root data-testid="self-host-disclaimer-banner">
          <ShieldAlertIcon />
          <Alert.Description>
            Du verlässt die Pulse-Cloud — dieser Server wird von
            <strong>{resolvedHostname.replace(/^https?:\/\//, '')}</strong>
            betrieben, dort gelten andere Regeln und Datenschutz-Bestimmungen.
          </Alert.Description>
        </Alert.Root>

        <div class="space-y-1.5">
          <Label
            for="add-server-invite"
            class="text-muted-foreground text-xs font-semibold uppercase tracking-wide"
          >
            Invite-Code (optional)
          </Label>
          <Input
            id="add-server-invite"
            type="text"
            bind:value={inviteInput}
            autocomplete="off"
            placeholder="Vom Self-Host-Admin"
            data-testid="add-server-invite"
          />
          <p class="text-text-muted text-xs">
            Mit Cert-Login: dein Identitäts-Cert wird gegen den Server signiert,
            danach (falls Code gesetzt) tritt dieser Account dem Server bei.
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
            Zurück
          </Button>
          <Button onclick={confirmAdd} disabled={busy} data-testid="add-server-confirm">
            {busy ? 'Füge hinzu…' : 'Verstanden, hinzufügen'}
          </Button>
        </Dialog.Footer>
      </div>
    {/if}
  </Dialog.Content>
</Dialog.Root>
