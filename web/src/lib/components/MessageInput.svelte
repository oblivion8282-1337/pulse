<script lang="ts">
  import { Button } from '$lib/components/ui/button/index.js';
  import * as DropdownMenu from '$lib/components/ui/dropdown-menu/index.js';
  import SendHorizontalIcon from '@lucide/svelte/icons/send-horizontal';
  import SmilePlusIcon from '@lucide/svelte/icons/smile-plus';
  import PaperclipIcon from '@lucide/svelte/icons/paperclip';
  import XIcon from '@lucide/svelte/icons/x';
  import EmojiPicker from './EmojiPicker.svelte';
  import AttachmentPreviewStrip from './AttachmentPreviewStrip.svelte';
  import MentionTriggerOverlay from './MentionTriggerOverlay.svelte';
  import { m } from '$lib/paraglide/messages.js';
  import { expandShortcodes } from '$lib/emoji';
  import { startUpload, cleanupRow, type PendingAttachment } from '$lib/attachments/upload.svelte';
  import { guilds } from '$lib/stores/guilds.svelte';
  import { lookupComposer } from '$lib/shortcuts/engine.svelte';
  import { applyComposerAction } from '$lib/shortcuts/composerActions';
  import { isElectron } from '$lib/platform/runtime';

  // `channelId` null → watch-party / stream-chat composer: attachments
  // (paperclip / paste / drop) are wired off, mention popup still works.
  let {
    channelId = null,
    placeholder = m.message_input_placeholder(),
    onSend,
    onTyping,
    replyTo = null,
    onCancelReply,
    disabled = false,
    disabledReason = '',
    handleDrop = true
  }: {
    channelId?: string | null;
    placeholder?: string;
    onSend: (text: string, attachmentIds: string[]) => void;
    /** Fired (cheaply, on every keystroke with non-empty content) so the
     *  parent can broadcast a debounced "typing" signal. Optional — the
     *  stream/watch-party chat composer doesn't wire it. */
    onTyping?: () => void;
    replyTo?: { id: string; author: string; snippet: string } | null;
    onCancelReply?: () => void;
    /** When false, this composer skips its own drag-drop (overlay + handlers)
     *  because a parent owns a wider drop zone (ChatView makes the whole
     *  channel droppable and forwards files via `addExternalFiles`). Default
     *  true keeps the standalone stream/watch-party chat composer droppable. */
    handleDrop?: boolean;
    /** When true the input, attachment button and submit are inert. Used
     *  by the DM hard-cut foundation (Etappe 4): DMs without a confirmed
     *  friendship freeze the composer until friendship resumes. The
     *  banner UI lives in Etappe 5 — this prop only locks the form. */
    disabled?: boolean;
    /** Optional explanatory text shown in the input's placeholder when
     *  ``disabled`` is true (otherwise unused). */
    disabledReason?: string;
  } = $props();

  const attachmentsEnabled = $derived(channelId !== null);

  let text = $state('');
  let pickerOpen = $state(false);
  let textarea: HTMLTextAreaElement | undefined = $state();
  let fileInput: HTMLInputElement | undefined = $state();

  // Pending uploads + their abort handles. Each `row` carries its own
  // local id so we can find + replace it on state-change callbacks.
  let pending = $state<PendingAttachment[]>([]);
  const aborts = new Map<string, () => void>();

  let isDragging = $state(false);
  let dragDepth = 0; // dragenter/leave fire on every child — count to stay sane

  // Drag&drop file upload is gated off in the Electron desktop app: a sandboxed
  // renderer loading the remote web app can't read OS-dropped file bytes
  // (size 0 → upload 422). `handleDrop` still lets a parent own the zone
  // (ChatView). Browsers are unaffected — drop works there.
  const dropEnabled = $derived(handleDrop && !isElectron());

  // Mention overlay owns the popup state; we just forward textarea events.
  let mentionOverlay: MentionTriggerOverlay | undefined = $state();

  // DM channels aren't in the store → guildId stays null → autocomplete
  // suppresses role + everyone suggestions.
  const guildId = $derived(channelId ? guilds.guildIdForChannel(channelId) : null);

  const anyUploading = $derived(pending.some((p) => p.state === 'uploading' || p.state === 'queued'));
  const sendDisabled = $derived(
    disabled || (text.trim().length === 0 && pending.length === 0) || anyUploading
  );
  const effectivePlaceholder = $derived(
    disabled && disabledReason ? disabledReason : placeholder
  );

  function addFiles(files: FileList | File[]): void {
    if (!channelId) return; // attachmentsEnabled=false → ignore drops/pastes silently
    for (const file of Array.from(files)) {
      const { row, abort } = startUpload(channelId, file, (next) => {
        pending = pending.map((p) => (p.localId === next.localId ? next : p));
      });
      pending = [...pending, row];
      aborts.set(row.localId, abort);
    }
  }

  /** Entry point for files dropped *outside* the composer — the whole
   *  ChatView is a drop zone (Discord-style), and it forwards the files here
   *  so they land in this composer's pending-upload strip. No-op when
   *  attachments are off (watch-party / stream chat). */
  export function addExternalFiles(files: FileList | File[]): void {
    addFiles(files);
  }

  function removeAttachment(localId: string) {
    aborts.get(localId)?.();
    aborts.delete(localId);
    const row = pending.find((p) => p.localId === localId);
    if (row) cleanupRow(row);
    pending = pending.filter((p) => p.localId !== localId);
  }
  const onFilePick = (e: Event) => {
    const input = e.currentTarget as HTMLInputElement;
    if (input.files) addFiles(input.files);
    input.value = ''; // allow re-selecting the same file later
  };
  const onPaste = (e: ClipboardEvent) => {
    const files = e.clipboardData?.files;
    // Skip file-paste in Electron: the pasted file's bytes are unreadable in
    // the sandboxed remote renderer (size 0 → 422). Text paste is untouched
    // (no files → early return → browser default). Browser file-paste works.
    if (!files?.length || isElectron()) return;
    e.preventDefault(); // don't paste a path string into the textarea
    addFiles(files);
  };

  function fire() {
    if (sendDisabled) return;
    const value = expandShortcodes(text).trim();
    // Convert `@DisplayName` placeholders back to `<@id>` wire format before
    // sending. The overlay tracked each autocomplete insertion; manually typed
    // @-patterns are left as-is (they won't match the tracked display texts).
    const markupValue = mentionOverlay?.toMarkup(value) ?? value;
    const ids = pending.filter((p) => p.state === 'done' && p.attachmentId).map((p) => p.attachmentId!);
    if (!markupValue && ids.length === 0) return;
    onSend(markupValue, ids);
    text = '';
    pending.forEach(cleanupRow);
    pending = [];
    aborts.clear();
    mentionOverlay?.clear();
  }

  function onKeydown(e: KeyboardEvent) {
    if (mentionOverlay?.handleKey(e)) return; // popup gets first dibs on ↑/↓/Enter/Tab/Esc
    const composerAction = lookupComposer(e);
    if (composerAction && textarea && applyComposerAction(composerAction, textarea, text, (v) => (text = v))) {
      e.preventDefault();
      mentionOverlay?.update();
      return;
    }
    if (e.key === 'Escape' && replyTo) { e.preventDefault(); onCancelReply?.(); return; }
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); fire(); }
  }

  function onDragEnter(e: DragEvent) {
    if (!dropEnabled || !e.dataTransfer?.types.includes('Files')) return;
    e.preventDefault(); dragDepth++; isDragging = true;
  }
  const onDragOver = (e: DragEvent) =>
    dropEnabled && e.dataTransfer?.types.includes('Files') && e.preventDefault();
  const onDragLeave = () => {
    if (!dropEnabled) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) isDragging = false;
  };
  function onDrop(e: DragEvent) {
    // When a parent owns the drop zone (handleDrop=false) — or we're in the
    // Electron app where drop is disabled (dropEnabled=false) — we don't touch
    // the event. handleDrop=false lets it bubble to the ChatView section
    // handler; Electron just no-ops (the 📎 picker is the path there).
    if (!dropEnabled) return;
    e.preventDefault(); e.stopPropagation(); dragDepth = 0; isDragging = false;
    if (e.dataTransfer?.files?.length) addFiles(e.dataTransfer.files);
  }

  const onMentionSync = () => mentionOverlay?.update();

  function insertEmoji(emoji: string) {
    const ta = textarea;
    if (!ta) { text = text + emoji; pickerOpen = false; return; }
    const start = ta.selectionStart ?? text.length;
    const end = ta.selectionEnd ?? text.length;
    text = text.slice(0, start) + emoji + text.slice(end);
    queueMicrotask(() => { ta.focus(); ta.setSelectionRange(start + emoji.length, start + emoji.length); });
    pickerOpen = false;
  }
</script>

<form
  class="px-2 pt-2 pb-[calc(1.25rem+var(--safe-bottom))] md:px-4 md:pb-5"
  ondragenter={onDragEnter}
  ondragover={onDragOver}
  ondragleave={onDragLeave}
  ondrop={onDrop}
  onsubmit={(e) => { e.preventDefault(); fire(); }}
>
  {#if replyTo}
    <div
      class="bg-bg-input mb-1 flex items-center gap-2 rounded-t-xl border border-b-0 border-border px-3 py-1.5 text-xs"
      data-testid="reply-banner"
    >
      <span class="text-text-muted">{m.message_input_reply_to()}</span>
      <span class="text-text-bright font-semibold">{replyTo.author}</span>
      <span class="text-text-muted truncate">— {replyTo.snippet}</span>
      <button
        type="button"
        class="text-text-muted hover:text-text-bright ml-auto rounded p-0.5"
        aria-label={m.message_input_cancel_reply()}
        onclick={() => onCancelReply?.()}
      >
        <XIcon class="size-3.5" />
      </button>
    </div>
  {/if}

  <AttachmentPreviewStrip {pending} onRemove={removeAttachment} />

  <div
    class="bg-bg-input relative flex items-center gap-1.5 border border-border px-3 py-3.5 backdrop-blur-sm md:items-end md:gap-2 md:px-4 md:py-3
           {replyTo || pending.length > 0 ? 'rounded-b-2xl rounded-t-none' : 'rounded-2xl'}"
  >
    {#if isDragging}
      <div
        class="bg-primary/15 border-primary text-primary pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-2xl border-2 border-dashed text-sm font-medium"
        data-testid="drop-overlay"
      >
        {m.message_input_drop_files_hint()}
      </div>
    {/if}
    {#if attachmentsEnabled}
      <input
        type="file"
        multiple
        bind:this={fileInput}
        onchange={onFilePick}
        class="sr-only"
        data-testid="attachment-file-input"
      />
      <button
        type="button"
        class="text-text-muted hover:bg-bg-hover hover:text-text-bright rounded-md p-2.5 md:p-1.5"
        aria-label={m.message_input_attach_file()}
        onclick={() => fileInput?.click()}
        data-testid="attachment-button"
      >
        <PaperclipIcon class="size-5" />
      </button>
    {/if}
    <textarea
      bind:this={textarea}
      rows="1"
      bind:value={text}
      onkeydown={onKeydown}
      oninput={() => { mentionOverlay?.update(); if (text.trim()) onTyping?.(); }}
      onkeyup={onMentionSync}
      onclick={onMentionSync}
      onpaste={onPaste}
      onblur={() => mentionOverlay?.close()}
      placeholder={effectivePlaceholder}
      {disabled}
      class="text-text-bright placeholder:text-text-muted max-h-40 min-h-[2rem] flex-1 resize-none border-0 bg-transparent text-[15px] outline-none disabled:cursor-not-allowed disabled:opacity-60 md:min-h-[1.5rem]"
      data-testid="message-input"
    ></textarea>
    <MentionTriggerOverlay
      bind:this={mentionOverlay}
      value={text}
      textareaEl={textarea}
      {guildId}
      onChange={(t) => (text = t)}
    />
    <DropdownMenu.Root bind:open={pickerOpen}>
      <DropdownMenu.Trigger>
        {#snippet child({ props })}
          <button
            {...props}
            type="button"
            class="text-text-muted hover:bg-bg-hover hover:text-text-bright rounded-md p-2.5 md:p-1.5"
            aria-label={m.message_input_insert_emoji()}
            data-testid="emoji-button"
          >
            <SmilePlusIcon class="size-5" />
          </button>
        {/snippet}
      </DropdownMenu.Trigger>
      <DropdownMenu.Content
        side="top"
        align="end"
        sideOffset={6}
        class="w-auto max-w-[calc(100vw-1rem)] overflow-visible border-0 bg-transparent p-0 shadow-none"
      >
        <EmojiPicker onPick={insertEmoji} />
      </DropdownMenu.Content>
    </DropdownMenu.Root>
    <Button
      type="submit"
      size="icon-sm"
      class="size-11 md:size-8"
      disabled={sendDisabled}
      data-testid="message-send"
      aria-label={m.message_input_send()}
    >
      <SendHorizontalIcon />
    </Button>
  </div>
</form>
