<!--
  „Mit KI installieren": ein fertiger Prompt aus Referenz-URL und dem
  personalisierten Befehl. Die Referenz (/install/guide) beschreibt Installer,
  Architektur und Fehlersuche — damit kann ein Assistent bei Proxy-, DNS- oder
  Port-Problemen gezielt helfen, statt zu raten.

  Steht bewusst UNTER den beiden Wegen: es ist keine dritte Art zu
  installieren, sondern Hilfe zu den beiden darüber.
-->
<script lang="ts">
  import { toast } from 'svelte-sonner';
  import { m } from '$lib/paraglide/messages.js';
  import { Button } from '$lib/components/ui/button';
  import CopyIcon from '@lucide/svelte/icons/copy';
  import CheckIcon from '@lucide/svelte/icons/check';

  let { befehl, base }: { befehl: string; base: string } = $props();

  let kopiert = $state(false);
  let prompt = $derived(
    befehl ? m.instance_setup_ai_prompt({ guideUrl: `${base}/install/guide`, command: befehl }) : ''
  );

  async function kopieren() {
    if (!prompt) return;
    try {
      await navigator.clipboard.writeText(prompt);
      kopiert = true;
      setTimeout(() => (kopiert = false), 1500);
    } catch {
      toast.error(m.instance_setup_error());
    }
  }
</script>

{#if befehl}
  <div class="border-border rounded-xl border p-3">
    <p class="text-text-bright mb-1 text-xs font-semibold">{m.instance_setup_ai_title()}</p>
    <p class="text-text-muted mb-2 text-xs">{m.instance_setup_ai_hint()}</p>
    <div class="flex flex-wrap items-center gap-3">
      <Button
        variant="outline"
        size="xs"
        onclick={() => void kopieren()}
        data-testid="instance-setup-ai-copy"
      >
        {#if kopiert}
          <CheckIcon class="size-3.5 text-success" />
        {:else}
          <CopyIcon class="size-3.5" />
        {/if}
        {m.instance_setup_ai_copy()}
      </Button>
      <a
        href="{base}/install/guide"
        target="_blank"
        rel="noopener noreferrer"
        class="text-text-muted hover:text-text-bright text-xs underline"
      >
        {m.instance_setup_ai_guide_link()}
      </a>
    </div>
  </div>
{/if}
