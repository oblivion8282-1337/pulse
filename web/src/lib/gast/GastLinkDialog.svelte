<script lang="ts">
  /**
   * Gast-Links eines Sprachkanals: erzeugen, sehen, entwerten.
   *
   * Der Code steht nur EINMAL da — direkt nach dem Erzeugen. Serverseitig
   * liegt nur sein Hash, es gibt ihn danach nirgends mehr. Deshalb der
   * Hinweis und der Kopieren-Knopf gleich daneben.
   */
  import * as Dialog from '$lib/components/ui/dialog/index.js';
  import { Button } from '$lib/components/ui/button';
  import { toast } from 'svelte-sonner';
  import { m } from '$lib/paraglide/messages.js';
  import {
    createGastLink,
    gastLinkUrl,
    listGastLinks,
    revokeGastLink,
    type GastLink
  } from '$lib/api/gastLinks';

  let {
    open = $bindable(false),
    channelId,
    guildId
  }: { open: boolean; channelId: string; guildId: string } = $props();

  let links = $state<GastLink[]>([]);
  let frischerCode = $state<string | null>(null);
  let laedt = $state(false);

  $effect(() => {
    if (!open) return;
    frischerCode = null;
    void laden();
  });

  async function laden() {
    try {
      const alle = await listGastLinks(guildId);
      links = alle.filter((l) => l.channel_id === channelId);
    } catch {
      links = [];
    }
  }

  async function erzeugen() {
    laedt = true;
    try {
      const link = await createGastLink(channelId);
      frischerCode = link.code ?? null;
      await laden();
      if (frischerCode) await kopieren(frischerCode);
    } finally {
      laedt = false;
    }
  }

  async function kopieren(code: string) {
    try {
      await navigator.clipboard.writeText(gastLinkUrl(code));
      toast.success(m.gast_links_kopiert());
    } catch {
      // Zwischenablage verweigert (kein sicherer Kontext, kein Nutzerklick):
      // der Link steht sichtbar im Dialog, der Gastgeber markiert ihn selbst.
    }
  }

  async function entwerten(id: string) {
    await revokeGastLink(id);
    await laden();
  }

  function datum(iso: string): string {
    return new Date(iso).toLocaleString();
  }
</script>

<Dialog.Root bind:open>
  <Dialog.Content class="sm:max-w-lg">
    <Dialog.Header>
      <Dialog.Title>{m.gast_links_titel()}</Dialog.Title>
      <Dialog.Description>{m.gast_links_hinweis()}</Dialog.Description>
    </Dialog.Header>

    {#if frischerCode}
      <div class="space-y-2 rounded-md border p-3">
        <p class="text-muted-foreground text-xs">{m.gast_links_code_einmal()}</p>
        <div class="flex items-center gap-2">
          <code class="bg-muted min-w-0 flex-1 truncate rounded px-2 py-1 text-xs" data-testid="gast-link-url">
            {gastLinkUrl(frischerCode)}
          </code>
          <Button size="sm" variant="secondary" onclick={() => kopieren(frischerCode!)}>
            {m.gast_links_kopiert()}
          </Button>
        </div>
      </div>
    {/if}

    <ul class="space-y-2">
      {#each links as link (link.id)}
        <li class="flex items-center justify-between gap-3 rounded-md border px-3 py-2 text-sm">
          <span class="text-muted-foreground truncate">
            {link.revoked ? m.gast_links_entwertet() : m.gast_links_laeuft_ab({ datum: datum(link.expires_at) })}
          </span>
          {#if !link.revoked}
            <Button size="sm" variant="ghost" onclick={() => entwerten(link.id)} data-testid="gast-link-entwerten">
              {m.gast_links_entwerten()}
            </Button>
          {/if}
        </li>
      {:else}
        <li class="text-muted-foreground py-2 text-sm">{m.gast_links_leer()}</li>
      {/each}
    </ul>

    <Dialog.Footer>
      <Button onclick={erzeugen} disabled={laedt} data-testid="gast-link-erzeugen">
        {m.gast_links_erzeugen()}
      </Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
