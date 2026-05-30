<!--
  Small informational banner shown above MessageInput when the composer
  is locked (DM friendship lost or user blocked). The reason string comes
  from the backend via the DM channel's `can_send` / `disabled_reason`
  field. Displayed by ChatView when composerDisabled === true.
-->
<script lang="ts">
  import { m } from '$lib/paraglide/messages.js';

  let { reason }: { reason: string } = $props();

  let text = $derived(
    reason === 'not_friends'
      ? m.composer_disabled_banner_not_friends()
      : reason === 'blocked'
        ? m.composer_disabled_banner_blocked()
        : m.composer_disabled_banner_default()
  );
</script>

<div
  class="bg-bg-input mx-4 mb-2 flex items-center gap-3 rounded-xl border border-border px-4 py-3"
  data-testid="composer-disabled-banner"
  role="status"
>
  <span class="text-text-muted text-lg">🔒</span>
  <p class="text-text-muted text-sm">{text}</p>
</div>
