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
  import { canRecoverDroppedFiles, recoverDroppedFiles } from '$lib/platform/electronFiles';
  import { drafts } from '$lib/stores/drafts.svelte';
  import { untrack } from 'svelte';

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
    handleDrop = true,
    attachmentsAllowed = true,
    attachmentAccept = ''
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
    /** False → this instance forbids attachments here (Cloud DMs). Removes the
     *  paperclip AND the paste/drop paths — hiding only the button would leave
     *  two working back doors into an endpoint the server 403s anyway. */
    attachmentsAllowed?: boolean;
    /** `accept` list for the file dialog (e.g. `image/*`); empty = anything.
     *  Cosmetic pre-filter only — the server enforces the same allowlist. */
    attachmentAccept?: string;
  } = $props();

  const attachmentsEnabled = $derived(channelId !== null && attachmentsAllowed);

  let text = $state('');
  let pickerOpen = $state(false);

  // Entwurf je Channel (auch DMs): beim Mount/Channel-Wechsel wiederherstellen …
  // (untrack: der Effect soll nur auf channelId reagieren, nicht auf spätere
  // Draft-Schreibvorgänge — sonst würde jeder Tastendruck ihn re-triggern.)
  $effect(() => {
    const id = channelId;
    text = id ? untrack(() => drafts.get(id)) : '';
  });
  // … und laufend sichern. Leerer Text löscht den Entwurf — damit räumt auch
  // das `text = ''` nach dem Senden den Entwurf automatisch weg. Deklaration
  // NACH dem Restore-Effect: beim Channel-Wechsel läuft erst der Restore,
  // dann sichert dieser Effect den frisch geladenen (unveränderten) Text.
  $effect(() => {
    const id = channelId;
    const t = text;
    if (id) untrack(() => drafts.set(id, t));
  });
  let textarea: HTMLTextAreaElement | undefined = $state();
  let fileInput: HTMLInputElement | undefined = $state();

  // Pending uploads + their abort handles. Each `row` carries its own
  // local id so we can find + replace it on state-change callbacks.
  let pending = $state<PendingAttachment[]>([]);
  const aborts = new Map<string, () => void>();

  // Leaving the channel (switch or unmount) abandons any in-flight uploads of
  // the previous channel: abort them and revoke their preview object-URLs so a
  // half-finished upload neither lands in a channel we left nor leaks memory.
  $effect(() => {
    void channelId; // track so the cleanup runs whenever the channel changes
    return () => {
      aborts.forEach((abort) => abort());
      aborts.clear();
      pending.forEach(cleanupRow);
      pending = [];
    };
  });

  let isDragging = $state(false);
  let dragDepth = 0; // dragenter/leave fire on every child — count to stay sane

  // Drag&drop file upload. In the Electron desktop app the sandboxed renderer
  // can't read OS-dropped file bytes directly (size 0 → upload 422) — but a
  // current shell exposes a native bridge that recovers them, so drop is enabled
  // when that bridge is present. Older shells (no bridge) stay disabled.
  // `handleDrop` still lets a parent own the zone (ChatView). Browsers: always on.
  const dropEnabled = $derived(
    handleDrop && attachmentsAllowed && (!isElectron() || canRecoverDroppedFiles())
  );

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
    // Single choke point for every entry path (picker, paste, drop, and the
    // parent's `addExternalFiles`) — guarding here rather than at each call
    // site is what keeps paste/drop from staying live once the button is gone.
    if (!channelId || !attachmentsAllowed) return;
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
    const dt = e.clipboardData;
    if (!dt) return;
    // A pasted image (e.g. a screenshot) lives in the clipboard as inline bytes,
    // not as a file on disk — so it's readable even in the sandboxed Electron
    // renderer (unlike a *dropped* file, which is a path the sandbox can't
    // reach). Collect every clipboard entry that carries real bytes; skip
    // 0-byte entries (a copied file *reference* shows up empty in the sandbox)
    // and plain text (→ no files → browser default paste).
    const collected: File[] = [];
    for (const item of Array.from(dt.items)) {
      if (item.kind === 'file' && item.type.startsWith('image/')) {
        const f = item.getAsFile();
        if (f && f.size > 0) collected.push(f);
      }
    }
    for (const f of Array.from(dt.files)) {
      if (f.size > 0 && !collected.some((c) => c.name === f.name && c.size === f.size)) {
        collected.push(f);
      }
    }
    if (!collected.length) return; // nothing usable → leave default paste alone
    e.preventDefault(); // don't also drop a path/text into the textarea
    addFiles(collected);
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
    // !e.isComposing: während einer IME-Komposition (CJK) bestätigt Enter den
    // Kandidaten — NICHT senden, sonst ginge der noch nicht committete Text
    // verloren (compositionend feuert erst nach diesem keydown).
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); fire(); }
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
  async function onDrop(e: DragEvent) {
    // When a parent owns the drop zone (handleDrop=false) — or an older Electron
    // shell without the file bridge (dropEnabled=false) — we don't touch the
    // event so it can bubble to the ChatView section handler.
    if (!dropEnabled) return;
    e.preventDefault(); e.stopPropagation(); dragDepth = 0; isDragging = false;
    const list = e.dataTransfer?.files;
    if (!list?.length) return;
    // In Electron the dropped files arrive with 0 bytes — recover them through
    // the native bridge before uploading.
    const files = isElectron() ? await recoverDroppedFiles(list) : list;
    if (files.length) addFiles(files);
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

  // Auto-Grow (Discord-Stil): das Eingabefeld wächst mit dem Inhalt mit, statt
  // ihn auf eine Zeile abzuschneiden. `text` als Abhängigkeit deckt JEDEN
  // Änderungspfad ab — Tippen, Einfügen, Emoji, Composer-Aktionen und das
  // Leeren nach dem Senden (dann schrumpft es wieder). Die Höhe wird auf
  // `scrollHeight` gesetzt; das CSS `max-h-40` deckelt sie und lässt darüber
  // scrollen. `height='auto'` zuerst, damit es beim Löschen auch wieder kleiner
  // wird (sonst bliebe der einmal erreichte Maximalwert stehen).
  $effect(() => {
    void text;
    const ta = textarea;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = `${ta.scrollHeight}px`;
  });
</script>

<form
  class="px-2 pt-2 pb-[calc(1.25rem+var(--safe-bottom))] md:px-2 md:pb-2"
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
    class="bg-bg-input relative flex items-center gap-1.5 border border-border px-3 py-3.5 shadow-[var(--panel-shadow)] backdrop-blur-sm md:items-end md:gap-2 md:px-4 md:py-3 dark:shadow-none
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
        accept={attachmentAccept || undefined}
        bind:this={fileInput}
        onchange={onFilePick}
        class="sr-only"
        data-testid="attachment-file-input"
      />
      <Button
        variant="ghost"
        size="icon"
        aria-label={m.message_input_attach_file()}
        onclick={() => fileInput?.click()}
        data-testid="attachment-button"
      >
        <PaperclipIcon class="size-5" />
      </Button>
    {/if}
    <!-- `min-h-9` + `py-1.5`: Der Kasten ist damit so hoch wie die Knöpfe daneben
         (36px) und führt seine Zeile selbst mittig. Vorher war er 24px hoch, und
         weil die Reihe auf dem Desktop mit `items-end` unten ausrichtet, klebte
         seine Unterkante an den Knöpfen — die Textzeile landete dadurch 5,3px
         UNTER der Feldmitte (gemessen). Auf dem Handy (`items-center`, vorher
         32px) kippte es aus demselben Grund in die andere Richtung.
         `items-end` am Container bleibt: das ist richtig, sobald der Text
         mehrzeilig wird und die Knöpfe unten stehen bleiben sollen. -->
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
      class="text-text-bright placeholder:text-text-muted max-h-40 min-h-9 flex-1 resize-none overflow-y-auto border-0 bg-transparent py-1.5 text-[15px] outline-none disabled:cursor-not-allowed disabled:opacity-60"
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
          <Button
            {...props}
            variant="ghost"
            size="icon"
            aria-label={m.message_input_insert_emoji()}
            data-testid="emoji-button"
          >
            <SmilePlusIcon class="size-5" />
          </Button>
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
