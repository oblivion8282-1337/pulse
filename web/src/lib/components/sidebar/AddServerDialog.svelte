<!--
  AddServerDialog — Phase 4.3.

  Drei-Schritt-Wizard:
    1. URL-Eingabe (https://… oder host:port)
    2. Pre-Check via /.well-known/pulse-server-info (Version, Issuer, Capabilities)
    3. Self-Host-Disclaimer + (optional) Invite-Code
  Nach „Hinzufügen": ServerEntry wird in serversStore geschrieben, der
  activeServer wechselt darauf, Dialog schließt.

  Cert-Auth ist STUB für Phase 4.3 — siehe TODO(Phase-5) unten. Mit Invite-
  Code: getInvitePreview()+acceptInvite() laufen gegen den NEUEN Server
  (via {serverId}-Route am request-Client), benötigen aber einen Session-
  Token den wir noch nicht haben → der echte End-to-End-Flow folgt in
  Phase 5 zusammen mit dem Cert-Challenge-Sign. Hier nur die URL-Persistenz.
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
  import { serversStore } from '$lib/api/servers.svelte';
  import { activeServer } from '$lib/stores/active-server.svelte';
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

  function confirmAdd(): void {
    if (!info || busy) return;
    busy = true;
    try {
      // TODO(Phase-5): Real Cert-Auth-Flow + Pairwise-Sub + Session-Token via
      // POST /cert-login. Dann auch getInvitePreview+acceptInvite gegen den
      // neuen Server fahren (request({serverId: entry.id})) und den Invite-Code
      // verwerten. Heute persistieren wir nur die URL + instance_id und
      // verlassen uns darauf dass der User danach ein Cert/Login-Flow durchläuft.
      const labelHost = resolvedHostname.replace(/^https?:\/\//, '');
      const entry = serversStore.add(
        resolvedHostname,
        labelHost,
        info.instance_id ?? undefined,
        undefined, // pairwise_sub bleibt null bis Phase 5
      );
      // Disclaimer als „gesehen" markieren — beide Keys setzen damit der
      // SelfHostDisclaimer-Banner (serverId-keyed) NICHT erneut hochpoppt.
      if (typeof window !== 'undefined') {
        try {
          window.localStorage.setItem(`pulse.disclaimer_accepted_${resolvedHostname}`, '1');
          window.localStorage.setItem(`pulse.disclaimer_seen_${entry.id}`, '1');
        } catch { /* Quota/Private-Browsing: silent */ }
      }
      activeServer.set(entry.id);
      toast.success(`${labelHost} hinzugefügt`);
      if (inviteInput.trim()) {
        // Invite-Code wurde eingegeben — informiere User dass Phase 5 fehlt.
        toast.info('Invite-Code wird beim nächsten Connect verarbeitet (Phase 5).');
      }
      reset();
      onClose();
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
            Phase-5-Feature: voller Cert-Auth-Flow folgt — heute wird der Code beim nächsten Connect ausgewertet.
          </p>
        </div>

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
