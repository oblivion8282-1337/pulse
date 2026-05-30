<script lang="ts">
  import { Button } from '$lib/components/ui/button/index.js';
  import Trash2Icon from '@lucide/svelte/icons/trash-2';
  import type { Invite } from '$lib/api/types';
  import { m } from '$lib/paraglide/messages.js';

  let {
    inv,
    onRevoke
  }: {
    inv: Invite;
    onRevoke: (code: string) => void;
  } = $props();

  function formatExpiry(expiresAt: string | null): string {
    if (!expiresAt) return m.invite_list_item_never_expires();
    const d = new Date(expiresAt);
    return m.invite_list_item_expires_on({ date: d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' }) });
  }
</script>

<li class="flex items-center justify-between rounded px-2 py-1.5 text-sm hover:bg-muted/50">
  <div class="min-w-0 flex-1">
    <span class="font-mono font-medium" data-testid={`invite-code-${inv.code}`}>{inv.code}</span>
    <span class="text-muted-foreground ml-2 text-xs">
      {m.invite_list_item_uses({ uses: inv.uses, maxUses: inv.max_uses != null ? `/${inv.max_uses}` : '' })} · {formatExpiry(inv.expires_at)}
    </span>
  </div>
  <Button
    variant="ghost"
    size="icon"
    class="text-muted-foreground hover:text-destructive ml-2 shrink-0"
    onclick={() => onRevoke(inv.code)}
    aria-label={m.invite_list_item_revoke_label()}
    data-testid={`invite-revoke-${inv.code}`}
  >
    <Trash2Icon class="size-4" />
  </Button>
</li>
