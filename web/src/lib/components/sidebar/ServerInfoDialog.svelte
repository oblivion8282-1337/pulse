<!--
  ServerInfoDialog — Read-Only-Info-Sheet für einen Server-Eintrag.
  Aus ServerSidebar extrahiert um die 250-Z-Component-Größen-Policy zu halten.
-->
<script lang="ts">
  import * as AlertDialog from '$lib/components/ui/alert-dialog/index.js';
  import { serverDisplayName, type ServerEntry } from '$lib/api/servers.svelte';
  import { serverState } from '$lib/ws/server-state.svelte';
  import { m } from '$lib/paraglide/messages.js';

  let {
    open = $bindable(false),
    server = null,
  }: {
    open?: boolean;
    server?: ServerEntry | null;
  } = $props();
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
