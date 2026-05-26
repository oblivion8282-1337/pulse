<!--
  ServerInfoDialog — Read-Only-Info-Sheet für einen Server-Eintrag.
  Aus ServerSidebar extrahiert um die 250-Z-Component-Größen-Policy zu halten.
-->
<script lang="ts">
  import * as AlertDialog from '$lib/components/ui/alert-dialog/index.js';
  import type { ServerEntry } from '$lib/api/servers.svelte';
  import { serverState } from '$lib/ws/server-state.svelte';

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
      <AlertDialog.Title>{server?.label}</AlertDialog.Title>
      <AlertDialog.Description>
        <span class="block">Hostname: <span class="font-mono">{server?.hostname}</span></span>
        {#if server?.instance_id}
          <span class="block">Instance: <span class="font-mono">{server.instance_id}</span></span>
        {/if}
        <span class="block">
          WS-Status:
          <span class="font-mono">
            {server ? serverState.get(server.id).state : ''}
          </span>
        </span>
      </AlertDialog.Description>
    </AlertDialog.Header>
    <AlertDialog.Footer>
      <AlertDialog.Action onclick={() => (open = false)}>Schließen</AlertDialog.Action>
    </AlertDialog.Footer>
  </AlertDialog.Content>
</AlertDialog.Root>
