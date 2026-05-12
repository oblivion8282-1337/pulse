<!--
  AddServerDialog — Dialog zum Anlegen eines eigenen Push-Servers (T3c).
  Pattern wie CreateChannelDialog. On submit landet das Profil + Stream-Key in
  der Settings-Persistenz (`window.pulse.store.*` unter Electron, `localStorage`
  im Browser-Fallback). Stream-Key wird im Klartext gespeichert; Schutz = chmod
  600 der Store-Datei auf Linux (siehe desktop/electron/store.ts). Niemals in
  `console.log`.
-->
<script lang="ts">
  import * as Dialog from '$lib/components/ui/dialog/index.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import { Input } from '$lib/components/ui/input/index.js';
  import { Label } from '$lib/components/ui/label/index.js';
  import EyeIcon from '@lucide/svelte/icons/eye';
  import EyeOffIcon from '@lucide/svelte/icons/eye-off';
  import { addCustomServer, type CustomServer } from '../settings.svelte';

  let {
    open = false,
    onClose,
  }: {
    open?: boolean;
    onClose: () => void;
  } = $props();

  let name = $state('');
  let host = $state('');
  let rtmpPort = $state(1935);
  let srtPort = $state(8890);
  let pushProtocol = $state<'rtmp' | 'srt'>('rtmp');
  let pushPath = $state('test');
  let username = $state('michael');
  let streamKey = $state('');
  let showKey = $state(false);
  let error = $state<string | null>(null);

  function reset() {
    name = '';
    host = '';
    rtmpPort = 1935;
    srtPort = 8890;
    pushProtocol = 'rtmp';
    pushPath = 'test';
    username = 'michael';
    streamKey = '';
    showKey = false;
    error = null;
  }

  function handleOpenChange(next: boolean) {
    if (!next) {
      reset();
      onClose();
    }
  }

  function validate(): string | null {
    if (!name.trim()) return 'Name darf nicht leer sein';
    if (!host.trim()) return 'Host darf nicht leer sein';
    const port = pushProtocol === 'rtmp' ? rtmpPort : srtPort;
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      return 'Port muss zwischen 1 und 65535 liegen';
    }
    return null;
  }

  function submit(e: SubmitEvent) {
    e.preventDefault();
    const v = validate();
    if (v) {
      error = v;
      return;
    }
    const port = pushProtocol === 'rtmp' ? rtmpPort : srtPort;
    const entry: CustomServer = {
      name: name.trim(),
      push_protocol: pushProtocol,
      push_host: host.trim(),
      push_port: port,
      push_path: pushPath.trim() || 'test',
      needs_auth: !!streamKey,
      auth_user: username.trim() || 'publisher',
      is_custom: true,
      stream_key: streamKey,
    };
    const err = addCustomServer(entry);
    if (err) {
      error = err;
      return;
    }
    reset();
    onClose();
  }
</script>

<Dialog.Root {open} onOpenChange={handleOpenChange}>
  <Dialog.Content data-testid="add-server-dialog">
    <Dialog.Header>
      <Dialog.Title>Eigener Server</Dialog.Title>
      <Dialog.Description>
        Push-Target für GSR-HQ-Streaming. Wird lokal gespeichert.
      </Dialog.Description>
    </Dialog.Header>
    <form class="space-y-4" onsubmit={submit}>
      <div class="space-y-1.5">
        <Label
          for="add-server-name"
          class="text-muted-foreground text-xs font-semibold uppercase tracking-wide"
        >
          Name
        </Label>
        <Input
          id="add-server-name"
          type="text"
          bind:value={name}
          required
          maxlength={64}
          placeholder="Mein Server"
          data-testid="add-server-name"
        />
      </div>

      <div class="space-y-1.5">
        <Label
          for="add-server-host"
          class="text-muted-foreground text-xs font-semibold uppercase tracking-wide"
        >
          Host
        </Label>
        <Input
          id="add-server-host"
          type="text"
          bind:value={host}
          required
          maxlength={253}
          placeholder="myserver.example.com"
          data-testid="add-server-host"
        />
      </div>

      <div class="grid grid-cols-2 gap-2">
        <Button
          type="button"
          variant={pushProtocol === 'rtmp' ? 'default' : 'secondary'}
          onclick={() => (pushProtocol = 'rtmp')}
          data-testid="add-server-protocol-rtmp"
        >
          RTMP
        </Button>
        <Button
          type="button"
          variant={pushProtocol === 'srt' ? 'default' : 'secondary'}
          onclick={() => (pushProtocol = 'srt')}
          data-testid="add-server-protocol-srt"
        >
          SRT
        </Button>
      </div>

      <div class="grid grid-cols-2 gap-3">
        <div class="space-y-1.5">
          <Label for="add-server-rtmp-port">RTMP-Port</Label>
          <Input
            id="add-server-rtmp-port"
            type="number"
            bind:value={rtmpPort}
            min={1}
            max={65535}
            disabled={pushProtocol !== 'rtmp'}
            data-testid="add-server-rtmp-port"
          />
        </div>
        <div class="space-y-1.5">
          <Label for="add-server-srt-port">SRT-Port</Label>
          <Input
            id="add-server-srt-port"
            type="number"
            bind:value={srtPort}
            min={1}
            max={65535}
            disabled={pushProtocol !== 'srt'}
            data-testid="add-server-srt-port"
          />
        </div>
      </div>

      <div class="space-y-1.5">
        <Label for="add-server-path">Pfad / Stream-Name</Label>
        <Input
          id="add-server-path"
          type="text"
          bind:value={pushPath}
          maxlength={128}
          placeholder="test"
        />
      </div>

      <div class="space-y-1.5">
        <Label for="add-server-user">Username</Label>
        <Input
          id="add-server-user"
          type="text"
          bind:value={username}
          maxlength={64}
          placeholder="michael"
        />
      </div>

      <div class="space-y-1.5">
        <Label for="add-server-key">Stream-Key</Label>
        <div class="flex gap-2">
          <Input
            id="add-server-key"
            type={showKey ? 'text' : 'password'}
            bind:value={streamKey}
            autocomplete="off"
            spellcheck={false}
            data-testid="add-server-key"
          />
          <Button
            type="button"
            size="icon"
            variant="ghost"
            onclick={() => (showKey = !showKey)}
            aria-label={showKey ? 'Stream-Key verbergen' : 'Stream-Key anzeigen'}
          >
            {#if showKey}<EyeOffIcon class="size-4" />{:else}<EyeIcon class="size-4" />{/if}
          </Button>
        </div>
        <p class="text-text-muted text-xs">
          Wird lokal gespeichert (Linux: chmod 600). Nicht in fremde Hände.
        </p>
      </div>

      {#if error}
        <p class="text-xs text-red-400" role="alert" data-testid="add-server-error">{error}</p>
      {/if}

      <Dialog.Footer>
        <Button type="button" variant="ghost" onclick={() => handleOpenChange(false)}>
          Abbrechen
        </Button>
        <Button type="submit" data-testid="add-server-submit">Hinzufügen</Button>
      </Dialog.Footer>
    </form>
  </Dialog.Content>
</Dialog.Root>
