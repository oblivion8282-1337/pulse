<script lang="ts">
  /**
   * Shared block used by both the "enable 2FA" wizard and the
   * "regenerate backup codes" dialog. Renders the codes and a download-as-txt
   * helper. The "I saved them" confirmation lives on the caller — this view
   * is presentation-only.
   */
  import { toast } from 'svelte-sonner';
  import DownloadIcon from '@lucide/svelte/icons/download';
  import CopyIcon from '@lucide/svelte/icons/copy';
  import { m } from '$lib/paraglide/messages.js';
  import { Button } from '$lib/components/ui/button';

  let { codes }: { codes: string[] } = $props();

  function download() {
    const body = codes.join('\n') + '\n';
    const blob = new Blob([body], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'pulse-backup-codes.txt';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  async function copyAll() {
    try {
      await navigator.clipboard.writeText(codes.join('\n'));
      toast.success(m.backup_codes_view_copied_to_clipboard());
    } catch {
      toast.error(m.backup_codes_view_copy_failed());
    }
  }
</script>

<div class="flex flex-col gap-3" data-testid="backup-codes-view">
  <div
    class="bg-bg-input/60 border-border grid grid-cols-2 gap-2 rounded-xl border p-4 font-mono text-sm md:gap-1.5 md:p-3"
  >
    {#each codes as code (code)}
      <span class="text-text-bright select-all">{code}</span>
    {/each}
  </div>
  <div class="flex flex-wrap gap-2">
    <Button variant="secondary" size="xs" onclick={download} data-testid="backup-codes-download">
      <DownloadIcon class="size-3.5" />
      {m.backup_codes_view_download_txt()}
    </Button>
    <Button variant="secondary" size="xs" onclick={copyAll} data-testid="backup-codes-copy">
      <CopyIcon class="size-3.5" />
      {m.backup_codes_view_copy_all()}
    </Button>
  </div>
  <p class="text-text-muted text-xs">
    {m.backup_codes_view_hint()}
  </p>
</div>
