<!--
  Small informational banner shown above MessageInput when the composer
  is locked (DM friendship lost or user blocked). The reason string comes
  from the backend via the DM channel's `can_send` / `disabled_reason`
  field. Displayed by ChatView when composerDisabled === true.
-->
<script lang="ts">
  let { reason }: { reason: string } = $props();

  let text = $derived(
    reason === 'not_friends'
      ? 'Ihr seid keine Freunde mehr. Sende eine Freundschaftsanfrage, um wieder zu schreiben.'
      : reason === 'blocked'
        ? 'Diese Person ist blockiert. Entblockiere sie, um wieder zu schreiben.'
        : 'Du kannst nicht in diesen Chat schreiben.'
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
