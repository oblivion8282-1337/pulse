<script lang="ts">
  import * as Dialog from '$lib/components/ui/dialog/index.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import { Input } from '$lib/components/ui/input/index.js';
  import { Label } from '$lib/components/ui/label/index.js';
  import FieldLabel from '$lib/components/form/FieldLabel.svelte';
  import { chatApi } from '$lib/api/chat';
  import { guilds } from '$lib/stores/guilds.svelte';
  import { toast } from 'svelte-sonner';
  import { m } from '$lib/paraglide/messages.js';
  import NameColorEditor from '$lib/components/settings/NameColorEditor.svelte';
  import {
    sanitizeProfileColor,
    sanitizeGradientAngle,
    DEFAULT_GRADIENT_ANGLE
  } from '$lib/utils/nameColor';

  let {
    open = false,
    channel,
    onClose
  }: {
    open?: boolean;
    channel:
      | {
          id: string;
          name: string;
          type?: number;
          topic?: string | null;
          name_color?: string | null;
          name_color_secondary?: string | null;
          name_gradient_angle?: number | null;
          user_limit?: number;
        }
      | null;
    onClose: () => void;
  } = $props();

  const isVoice = $derived(channel?.type === 1);

  const DEFAULT_COLOR = '#3b82f6';
  const DEFAULT_SECONDARY = '#a78bfa';

  let name = $state('');
  let topic = $state('');
  let busy = $state(false);
  let useColor = $state(false);
  let color1 = $state(DEFAULT_COLOR);
  let useGradient = $state(false);
  let color2 = $state(DEFAULT_SECONDARY);
  let angle = $state(DEFAULT_GRADIENT_ANGLE);
  let userLimit = $state(0);

  $effect(() => {
    if (open && channel) {
      name = channel.name;
      topic = channel.topic ?? '';
      userLimit = channel.user_limit ?? 0;
      const safe1 = sanitizeProfileColor(channel.name_color);
      useColor = !!safe1;
      color1 = safe1 ?? DEFAULT_COLOR;
      const safe2 = sanitizeProfileColor(channel.name_color_secondary);
      useGradient = !!safe1 && !!safe2;
      color2 = safe2 ?? DEFAULT_SECONDARY;
      angle = sanitizeGradientAngle(channel.name_gradient_angle);
    }
  });

  function handleOpenChange(next: boolean) {
    if (!next) {
      name = '';
      topic = '';
      busy = false;
      onClose();
    }
  }

  async function submit(e: SubmitEvent) {
    e.preventDefault();
    if (!channel) return;
    // Name bleibt wie getippt (Groß-/Kleinschreibung, Leerzeichen) — nur
    // Mehrfach-Leerzeichen laufen auf eins zusammen. Slugify war Client-Only.
    const trimmedName = name.trim().replace(/\s+/g, ' ');
    const newTopic = topic.trim();
    const nameChanged = !!trimmedName && trimmedName !== channel.name;
    const topicChanged = newTopic !== (channel.topic ?? '');
    const desiredColor = useColor ? color1 : null;
    const desiredSecondary = useColor && useGradient ? color2 : null;
    const desiredAngle = useColor && useGradient ? angle : (channel.name_gradient_angle ?? null);
    const colorChanged = desiredColor !== sanitizeProfileColor(channel.name_color);
    const secondaryChanged =
      desiredSecondary !== sanitizeProfileColor(channel.name_color_secondary);
    const angleChanged = desiredAngle !== (channel.name_gradient_angle ?? null);
    // Nur Voice-Channels tragen ein Limit; clampen (0..99) gegen Tipp-Unfug.
    const desiredLimit = isVoice ? Math.max(0, Math.min(99, Math.round(userLimit || 0))) : 0;
    const limitChanged = isVoice && desiredLimit !== (channel.user_limit ?? 0);
    if (
      !nameChanged && !topicChanged && !colorChanged &&
      !secondaryChanged && !angleChanged && !limitChanged
    ) {
      onClose();
      return;
    }
    const patch: {
      name?: string;
      topic?: string;
      name_color?: string | null;
      name_color_secondary?: string | null;
      name_gradient_angle?: number | null;
      user_limit?: number;
    } = {};
    if (nameChanged) patch.name = trimmedName;
    if (topicChanged) patch.topic = newTopic;
    if (colorChanged) patch.name_color = desiredColor;
    if (secondaryChanged) patch.name_color_secondary = desiredSecondary;
    if (angleChanged) patch.name_gradient_angle = desiredAngle;
    if (limitChanged) patch.user_limit = desiredLimit;
    busy = true;
    try {
      const updated = await chatApi.patchChannel(channel.id, patch);
      guilds.updateChannel(updated);
      onClose();
    } catch (err) {
      toast.error(m.rename_channel_dialog_rename_failed(), { description: (err as Error).message });
    } finally {
      busy = false;
    }
  }
</script>

<Dialog.Root {open} onOpenChange={handleOpenChange}>
  <Dialog.Content data-testid="rename-channel-dialog">
    <Dialog.Header>
      <Dialog.Title>{m.rename_channel_dialog_title()}</Dialog.Title>
      <Dialog.Description>{m.rename_channel_dialog_description({ name: channel?.name ?? '' })}</Dialog.Description>
    </Dialog.Header>
    <form class="space-y-4" onsubmit={submit}>
      <div class="space-y-1.5">
        <FieldLabel for="rename-channel-name" required class="text-muted-foreground text-xs font-semibold uppercase tracking-wide">
          {m.rename_channel_dialog_channel_name_label()}
        </FieldLabel>
        <Input
          id="rename-channel-name"
          type="text"
          bind:value={name}
          required
          minlength={1}
          maxlength={64}
          disabled={busy}
          data-testid="rename-channel-name"
        />
      </div>
      <div class="space-y-1.5">
        <Label for="rename-channel-topic" class="text-muted-foreground text-xs font-semibold uppercase tracking-wide">
          {m.rename_channel_dialog_topic_label()}
        </Label>
        <Input
          id="rename-channel-topic"
          type="text"
          bind:value={topic}
          maxlength={1024}
          disabled={busy}
          placeholder={m.rename_channel_dialog_topic_placeholder()}
          data-testid="rename-channel-topic"
        />
      </div>
      {#if isVoice}
        <div class="space-y-1.5">
          <Label for="rename-channel-user-limit" class="text-muted-foreground text-xs font-semibold uppercase tracking-wide">
            {m.rename_channel_dialog_user_limit_label()}
          </Label>
          <Input
            id="rename-channel-user-limit"
            type="number"
            min={0}
            max={99}
            step={1}
            bind:value={userLimit}
            disabled={busy}
            data-testid="rename-channel-user-limit"
          />
          <p class="text-muted-foreground text-xs">{m.rename_channel_dialog_user_limit_hint()}</p>
        </div>
      {/if}
      <NameColorEditor
        bind:useColor
        bind:color1
        bind:useGradient
        bind:color2
        bind:angle
        previewName={name || channel?.name || ''}
      />
      <Dialog.Footer>
        <Button type="button" variant="ghost" onclick={() => handleOpenChange(false)} disabled={busy}>{m.rename_channel_dialog_cancel()}</Button>
        <Button type="submit" disabled={busy} data-testid="rename-channel-submit">
          {busy ? m.rename_channel_dialog_saving() : m.rename_channel_dialog_rename()}
        </Button>
      </Dialog.Footer>
    </form>
  </Dialog.Content>
</Dialog.Root>
