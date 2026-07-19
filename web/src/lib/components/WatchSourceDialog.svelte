<!--
  WatchSourceDialog — URL-Eingabe + Live-Parse-Feedback für eine Watch-Party-
  Quelle. Geteilt zwischen "Party starten" (WatchPartyStartButton) und "Video
  wechseln" (WatchPartyTile), damit beide dieselbe Validierung + Optik haben.

  `onConfirm(url)` gibt zurück, ob das Senden gelang: bei true schliesst der
  Dialog und leert das Feld, bei false bleibt er offen (die Call-Site zeigt den
  Fehler-Toast selbst). Der Backend re-validiert die URL ohnehin — die
  parseSource-Prüfung hier ist nur Sofort-Feedback.
-->
<script lang="ts">
  import { Button } from '$lib/components/ui/button/index.js';
  import * as Dialog from '$lib/components/ui/dialog/index.js';
  import { parseSource } from '$lib/watch/source';
  import { m } from '$lib/paraglide/messages.js';

  interface Props {
    open: boolean;
    title: string;
    confirmLabel: string;
    onConfirm: (url: string) => boolean;
  }

  let { open = $bindable(), title, confirmLabel, onConfirm }: Props = $props();

  let url = $state('');

  const parsed = $derived(url.trim() ? parseSource(url.trim()) : null);
  const showParseError = $derived(url.trim().length > 0 && parsed === null);

  const parsedLabel = $derived.by(() => {
    if (!parsed) return null;
    switch (parsed.type) {
      case 'youtube':
        return 'YouTube';
      case 'twitch':
        return 'Twitch VOD';
      case 'twitch_live':
        return m.watch_party_start_button_twitch_live({ channel: parsed.channel });
      default:
        return m.watch_party_start_button_direct_video();
    }
  });

  function confirm(): void {
    if (!parsed) return;
    if (onConfirm(url.trim())) {
      url = '';
      open = false;
    }
  }

  function handleKey(e: KeyboardEvent): void {
    if (e.key === 'Enter') {
      e.preventDefault();
      confirm();
    }
  }

  // Leeres Feld bei jedem Öffnen — nie eine alte URL vorausfüllen.
  $effect(() => {
    if (open) url = '';
  });
</script>

<Dialog.Root bind:open>
  <Dialog.Content class="max-w-md" data-testid="watch-party-dialog">
    <Dialog.Header>
      <Dialog.Title>{title}</Dialog.Title>
      <Dialog.Description>
        {m.watch_party_start_button_dialog_description()}
      </Dialog.Description>
    </Dialog.Header>
    <div class="flex flex-col gap-2 py-2">
      <input
        bind:value={url}
        onkeydown={handleKey}
        type="url"
        placeholder="https://youtu.be/..."
        class="border-border bg-bg-elev focus:border-primary text-text-bright w-full rounded-md border px-2 py-1.5 text-sm outline-none"
        data-testid="watch-party-url-input"
      />
      <div class="text-xs">
        {#if showParseError}
          <span class="text-destructive" data-testid="watch-party-parse-error">
            {m.watch_party_start_button_url_unsupported()}
          </span>
        {:else if parsedLabel}
          <span class="text-text-muted" data-testid="watch-party-parse-ok">
            {parsedLabel}
          </span>
        {:else}
          <span class="text-text-muted">
            {m.watch_party_start_button_url_hint()}
          </span>
        {/if}
      </div>
    </div>
    <Dialog.Footer>
      <Button variant="ghost" onclick={() => (open = false)}>
        {m.watch_party_start_button_cancel()}
      </Button>
      <Button onclick={confirm} disabled={!parsed} data-testid="watch-party-start-confirm">
        {confirmLabel}
      </Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
