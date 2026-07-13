<!--
  Zeigt das nach einer Secret-Rotation EINMALIG sichtbare neue client_secret
  (kein Auto-Dismiss). Ausgelagert aus AdminInstancesActive (Größen-Policy).
-->
<script lang="ts">
  import * as Dialog from '$lib/components/ui/dialog/index.js';
  import ClipboardIcon from '@lucide/svelte/icons/clipboard';
  import CheckIcon from '@lucide/svelte/icons/check';
  import { m } from '$lib/paraglide/messages.js';
  import type { RotateSecretResult } from '$lib/api/instances';

  let {
    open,
    result,
    onClose
  }: { open: boolean; result: RotateSecretResult | null; onClose: () => void } = $props();

  let copied = $state(false);

  async function copySecret() {
    if (!result?.client_secret) return;
    await navigator.clipboard.writeText(result.client_secret);
    copied = true;
    setTimeout(() => (copied = false), 2000);
  }
</script>

<Dialog.Root {open} onOpenChange={(v) => { if (!v) onClose(); }}>
  <Dialog.Portal>
    <Dialog.Overlay />
    <Dialog.Content class="max-w-md" data-testid="rotate-secret-dialog">
      <Dialog.Header>
        <Dialog.Title>{m.admin_instances_active_new_secret_title()}</Dialog.Title>
      </Dialog.Header>
      <div class="flex flex-col gap-3">
        <p class="text-amber-300 text-sm font-medium">{result?.warning}</p>
        <div class="bg-bg-input flex items-center gap-2 rounded-xl border border-border p-3">
          <code class="text-text-bright flex-1 break-all text-xs select-all">
            {result?.client_secret}
          </code>
          <button type="button" onclick={copySecret}
            class="text-text-muted hover:text-text-bright shrink-0 rounded p-1">
            {#if copied}
              <CheckIcon class="size-4 text-emerald-400" />
            {:else}
              <ClipboardIcon class="size-4" />
            {/if}
          </button>
        </div>
      </div>
      <div class="flex justify-end pt-2">
        <button type="button" onclick={onClose}
          class="bg-primary hover:bg-primary/90 text-white rounded-xl px-4 py-2 text-sm font-medium">
          {m.admin_instances_active_btn_acknowledged()}
        </button>
      </div>
    </Dialog.Content>
  </Dialog.Portal>
</Dialog.Root>
