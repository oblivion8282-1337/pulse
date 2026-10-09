<script lang="ts">
  /**
   * „Info" an einer eigenen Gruppennachricht (WhatsApp-Vorbild): wer sie
   * gelesen hat, bei wem sie angekommen ist, wer sie noch nicht hat. Der
   * blaue Haken sagt nur „alle" — hier steht, wer fehlt.
   *
   * Empfänger sind die Mitglieder zur Sendezeit, dieselbe Rechnung wie der
   * Haken selbst (`nachrichten/haekchenAnzeige.ts`). Zeiten gibt es keine:
   * der Server führt je Mitglied nur einen Stand, nicht einen je Nachricht.
   */
  import type { Message } from '$lib/api/types';
  import * as Dialog from '$lib/components/ui/dialog/index.js';
  import Haekchen from '$lib/components/message/Haekchen.svelte';
  import { infoFuer } from '$lib/nachrichten/haekchenAnzeige';
  import type { HaekchenStufe, InfoStatus } from '$lib/nachrichten/haekchen';
  import { auth } from '$lib/stores/auth.svelte';
  import { userCache } from '$lib/stores/users.svelte';
  import { m } from '$lib/paraglide/messages.js';

  let {
    message,
    open = $bindable(false),
    onClose
  }: {
    message: Message;
    open?: boolean;
    onClose: () => void;
  } = $props();

  const liste = $derived(open ? infoFuer(message, auth.user?.id) : []);

  $effect(() => {
    for (const eintrag of liste) userCache.queue(eintrag.konto);
  });

  const STUFE: Record<InfoStatus, HaekchenStufe> = {
    gelesen: 'gelesen',
    zugestellt: 'zugestellt',
    ausstehend: 'gesendet'
  };
  const TEXT: Record<InfoStatus, () => string> = {
    gelesen: m.message_haekchen_gelesen,
    zugestellt: m.message_haekchen_zugestellt,
    ausstehend: m.nachricht_info_ausstehend
  };
</script>

<Dialog.Root bind:open onOpenChange={(next) => !next && onClose()}>
  <Dialog.Content class="max-w-sm" data-testid="nachricht-info-dialog">
    <Dialog.Header>
      <Dialog.Title>{m.nachricht_info_titel()}</Dialog.Title>
      <Dialog.Description>{m.nachricht_info_beschreibung()}</Dialog.Description>
    </Dialog.Header>
    {#if liste.length === 0}
      <p class="text-text-muted text-sm">{m.nachricht_info_leer()}</p>
    {:else}
      <ul class="flex max-h-80 flex-col gap-1 overflow-y-auto" data-testid="nachricht-info-liste">
        {#each liste as eintrag (eintrag.konto)}
          <li class="flex items-center justify-between gap-3 rounded-lg px-2 py-1.5" data-status={eintrag.status}>
            <span class="text-text-bright truncate text-sm">{userCache.displayName(eintrag.konto)}</span>
            <span class="text-text-muted flex shrink-0 items-center text-xs">
              <Haekchen stufe={STUFE[eintrag.status]} />
              {TEXT[eintrag.status]()}
            </span>
          </li>
        {/each}
      </ul>
    {/if}
  </Dialog.Content>
</Dialog.Root>
