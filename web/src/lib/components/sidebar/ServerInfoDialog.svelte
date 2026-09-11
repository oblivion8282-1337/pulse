<!--
  ServerInfoDialog — Read-Only-Info-Sheet für einen Server-Eintrag.
  Aus ServerSidebar extrahiert um die 250-Z-Component-Größen-Policy zu halten.
-->
<script lang="ts">
  import * as AlertDialog from '$lib/components/ui/alert-dialog/index.js';
  import { serverDisplayName, type ServerEntry } from '$lib/api/servers.svelte';
  import { fetchServerInfo } from '$lib/api/server-info';
  import { serverState } from '$lib/ws/server-state.svelte';
  import { m } from '$lib/paraglide/messages.js';

  let {
    open = $bindable(false),
    server = null,
  }: {
    open?: boolean;
    server?: ServerEntry | null;
  } = $props();

  // Der Baustempel des angezeigten Servers (2026-09-11): aus dessen öffentlichem
  // well-known geholt, sobald das Kärtchen geöffnet wird. Wer mehrere Server
  // verbunden hat, sieht so auf einen Blick, welchen Stand jeder fährt —
  // derselbe Kurz-Code wie auf der eigenen Admin-Seite heißt byte-identisch.
  // Schlägt der Abruf fehl (offline, CORS), bleibt die Zeile einfach weg —
  // eine Kann-Info verdient keinen Fehlerhinweis.
  let buildVersion = $state('');

  $effect(() => {
    if (!open || !server?.hostname) return;
    buildVersion = '';
    const hostname = server.hostname;
    void (async () => {
      const basis = hostname.startsWith('http') ? hostname : `https://${hostname}`;
      const info = await fetchServerInfo(basis);
      if (info?.build_version) buildVersion = info.build_version;
    })();
  });
</script>

<AlertDialog.Root bind:open>
  <AlertDialog.Content data-testid="server-info-dialog">
    <AlertDialog.Header>
      <AlertDialog.Title>{server ? serverDisplayName(server) : ''}</AlertDialog.Title>
      <AlertDialog.Description>
        <span class="block">{m.server_info_dialog_hostname_label()} <span class="font-mono">{server?.hostname}</span></span>
        {#if server?.instance_id}
          <span class="block">{m.server_info_dialog_instance_label()} <span class="font-mono">{server.instance_id}</span></span>
        {/if}
        {#if buildVersion}
          <span class="block" data-testid="server-info-build-version" title={m.server_info_dialog_build_hint()}>
            {m.server_info_dialog_build_label()}
            <span class="font-mono">{buildVersion}</span>
          </span>
        {/if}
        <span class="block">
          {m.server_info_dialog_ws_status_label()}
          <span class="font-mono">
            {server ? serverState.get(server.id).state : ''}
          </span>
        </span>
      </AlertDialog.Description>
    </AlertDialog.Header>
    <AlertDialog.Footer>
      <AlertDialog.Action onclick={() => (open = false)}>{m.server_info_dialog_close()}</AlertDialog.Action>
    </AlertDialog.Footer>
  </AlertDialog.Content>
</AlertDialog.Root>
